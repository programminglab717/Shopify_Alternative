import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

/** The admin opened at a link's page, its token after the `#` as an email's link carries it. */
function openLink(path: string) {
  window.history.replaceState(null, '', path);
  return renderAdmin(path);
}

const refused = (status: number, error: Record<string, unknown>) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('The pages email links open', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('asks for a link to set a new password from signing in by email', async () => {
    const core = fakeCore('owner', () => ({}));
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/sign-in');

    fireEvent.click(await screen.findByRole('tab', { name: 'Email' }));
    (await screen.findByRole('link', { name: 'Forgot your password?' })).click();
    await screen.findByText(
      'Type the email you sign in with. We email it a link to set a new password.',
    );
    type('Email', ' sana@zari.pk ');
    await press('Email me a link');

    await screen.findByText(
      'If an account uses sana@zari.pk, we have emailed it a link. It works for an hour; look in spam too.',
    );
    expect(core.sent.find((each) => each.operation === '/auth/password/forgot')?.variables).toEqual(
      { email: 'sana@zari.pk', language: 'en' },
    );
  });

  it("sets a new password from a reset link, saying what's wrong with one, and signs this tab out", async () => {
    signedIn();
    let tries = 0;
    const core = fakeCore(
      'owner',
      () => ({}),
      (path) => {
        if (path === '/auth/password/reset') {
          tries += 1;
          return tries === 1
            ? refused(422, {
                code: 'INVALID_INPUT',
                message: 'Some details need fixing',
                fields: { password: 'This password is too common' },
              })
            : new Response(null, { status: 204 });
        }
        if (path === '/auth/sign-out') return new Response(null, { status: 204 });
        throw new Error(`unexpected ${path}`);
      },
    );
    vi.stubGlobal('fetch', core.fetcher);
    openLink('/reset-password#token=hpr_abc');

    await screen.findByLabelText('New password');
    type('New password', 'password123');
    await press('Set the password');
    await screen.findByText('This password is too common');

    type('New password', 'mango-chutney-42');
    await press('Set the password');
    await screen.findByText(
      'Your password is set. Every device signed in before is signed out: sign in with it now.',
    );
    expect(
      core.sent.filter((each) => each.operation === '/auth/password/reset').at(-1)?.variables,
    ).toEqual({ token: 'hpr_abc', password: 'mango-chutney-42' });
    expect(window.localStorage.getItem('hatti.session')).toBeNull();
  });

  it('confirms an email with a tap, and says when the link was used already', async () => {
    let used = false;
    const core = fakeCore(
      'owner',
      () => ({}),
      (path) => {
        if (path !== '/auth/email/verify') throw new Error(`unexpected ${path}`);
        if (used) {
          return refused(401, {
            code: 'INVALID_EMAIL_LINK',
            message: 'This link expired or was used',
          });
        }
        used = true;
        return { user: { id: 'usr_1', email: 'sana@zari.pk', emailVerified: true } };
      },
    );
    vi.stubGlobal('fetch', core.fetcher);
    openLink('/verify-email#token=hev_abc');

    // Nothing is spent by the page opening: only the tap confirms it.
    await screen.findByRole('button', { name: 'Confirm my email' });
    expect(core.sent).toHaveLength(0);
    await press('Confirm my email');
    await screen.findByText('Your email sana@zari.pk is confirmed.');
    expect(core.sent[0]?.variables).toEqual({ token: 'hev_abc' });

    cleanup();
    openLink('/verify-email#token=hev_abc');
    await screen.findByRole('button', { name: 'Confirm my email' });
    await press('Confirm my email');
    await screen.findByText('This link has expired or was used already. Ask for a new one.');
  });

  it('changes the email from the link sent to the new address', async () => {
    signedIn();
    const core = fakeCore(
      'owner',
      () => ({}),
      (path) => {
        if (path !== '/auth/email/change/confirm') throw new Error(`unexpected ${path}`);
        return { user: { id: 'usr_1', email: 'sana@zari.store', emailVerified: true } };
      },
    );
    vi.stubGlobal('fetch', core.fetcher);
    openLink('/change-email#token=hce_abc');

    await screen.findByRole('button', { name: 'Change my email' });
    await press('Change my email');
    await screen.findByText(
      "Your account's email is now sana@zari.store. We have told your old address.",
    );
    expect(core.sent.find((each) => each.operation === '/auth/email/change/confirm')).toEqual({
      operation: '/auth/email/change/confirm',
      variables: { token: 'hce_abc' },
    });
  });

  it('says a link without its token is missing a part', async () => {
    vi.stubGlobal('fetch', fakeCore('owner', () => ({})).fetcher);
    openLink('/reset-password');
    await screen.findByText('This link is missing a part. Open it again from the email.');
    expect(screen.queryByLabelText('New password')).toBeNull();
  });
});
