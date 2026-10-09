import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { htmlFromText, textFromHtml } from './page-body';

const REFUND_DRAFT = `<p>We want you to be happy with what you buy from Zari. If something is not right,
    tell us.</p>
    <h2>What can be returned</h2>
    <ul>
    <li>Items unused and unwashed, with their tags.</li>
    <li>Items that arrived damaged.</li>
    </ul>
    <p>Online: <a href="https://zari.pk">https://zari.pk</a></p>`;

const URDU_DRAFT =
  '<h2>واپسی</h2>\n<p>ہمیں <span dir="ltr">+92 300 1234567</span> پر واٹس ایپ کریں۔</p>';

const SHIPPING = {
  id: 'pol_2',
  type: 'SHIPPING_POLICY',
  title: 'Shipping policy',
  body: '<p>We deliver across Pakistan in 3 to 5 days.</p>',
  url: 'https://zari.pk/policies/shipping-policy',
};

function core(role: StaffRole, outdated = false) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Policies':
        return { shop: { shopPolicies: [SHIPPING] } };
      case 'PolicyDraft':
        return {
          shopPolicyDraft: {
            title: 'Refund policy',
            body: variables.locale === 'ur' ? URDU_DRAFT : REFUND_DRAFT,
          },
        };
      case 'PolicyUpdate':
        return { shopPolicyUpdate: { shopPolicy: { id: 'pol_1' }, userErrors: [] } };
      case 'PolicyTranslation':
        return {
          translatableResource: {
            resourceId: 'pol_2',
            translatableContent: [{ key: 'body', digest: 'dig_2' }],
            translations: outdated
              ? [{ key: 'body', value: '<p>تین سے پانچ دن۔</p>', outdated: true }]
              : [],
          },
        };
      case 'TranslationsRegister':
        return { translationsRegister: { userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).at(-1)?.variables;

describe("The shop's policies", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('writes headings, lists and links as text, and Latin in Urdu left to right', () => {
    const text = textFromHtml(REFUND_DRAFT);
    expect(text).toBe(
      [
        'We want you to be happy with what you buy from Zari. If something is not right, tell us.',
        '## What can be returned',
        '- Items unused and unwashed, with their tags.\n- Items that arrived damaged.',
        'Online: https://zari.pk',
      ].join('\n\n'),
    );
    expect(htmlFromText(text!)).toBe(
      [
        '<p>We want you to be happy with what you buy from Zari. If something is not right, tell us.</p>',
        '<h2>What can be returned</h2>',
        '<ul>\n<li>Items unused and unwashed, with their tags.</li>\n<li>Items that arrived damaged.</li>\n</ul>',
        '<p>Online: <a href="https://zari.pk">https://zari.pk</a></p>',
      ].join('\n'),
    );
    const urdu = textFromHtml(URDU_DRAFT)!;
    expect(urdu).toBe('## واپسی\n\nہمیں +92 300 1234567 پر واٹس ایپ کریں۔');
    expect(htmlFromText(urdu, { rtl: true })).toBe(
      '<h2>واپسی</h2>\n<p>ہمیں <span dir="ltr">+92 300 1234567</span> پر واٹس ایپ کریں۔</p>',
    );
    expect(textFromHtml('<p><a href="https://a.pk">our shop</a></p>')).toBeNull();
    expect(textFromHtml('<h3>Small</h3>')).toBeNull();
  });

  it('lists the five policies, and writes one from Hatti’s draft as text', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=policies');

    expect((await screen.findByRole('link', { name: /Delivery/ })).textContent).toContain(
      'Written',
    );
    const refunds = screen.getByRole('link', { name: /Returns and refunds/ });
    expect(refunds.textContent).toContain('Not written');
    expect(screen.getAllByRole('link', { name: /Written|Not written/ })).toHaveLength(5);
    fireEvent.click(refunds);

    fireEvent.click(await screen.findByRole('button', { name: "Start from Hatti's draft" }));
    const box = (await screen.findByDisplayValue(/## What can be returned/)) as HTMLTextAreaElement;
    expect(screen.queryByRole('region', { name: 'In Urdu' })).toBeNull();
    fireEvent.change(box, { target: { value: box.value.replace('Zari', 'Zari Lawn') } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sentOf(fake, 'PolicyUpdate')).toEqual({
        shopPolicy: {
          type: 'REFUND_POLICY',
          body: htmlFromText(textFromHtml(REFUND_DRAFT)!.replace('Zari', 'Zari Lawn')),
        },
      }),
    );
  });

  it("keeps a policy's Urdu as a translation of its words, and says when it is out of date", async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/policies/shipping-policy');

    expect(
      await screen.findByDisplayValue('We deliver across Pakistan in 3 to 5 days.'),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: "Start from Hatti's Urdu draft" }));
    expect(await screen.findByDisplayValue(/واٹس ایپ کریں/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save the Urdu' }));
    await waitFor(() =>
      expect(sentOf(fake, 'TranslationsRegister')).toEqual({
        resourceId: 'pol_2',
        translations: [
          { key: 'body', locale: 'ur', translatableContentDigest: 'dig_2', value: URDU_DRAFT },
        ],
      }),
    );
    cleanup();

    vi.stubGlobal('fetch', core('owner', true).fetcher);
    renderAdmin('/shop_1/online-store/policies/shipping-policy');
    expect(await screen.findByText(/Your words changed since this was written/)).toBeTruthy();
    expect(screen.getByDisplayValue('تین سے پانچ دن۔')).toBeTruthy();
  });

  it('takes a policy away after asking, and leaves policies to owners and managers', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/policies/shipping-policy');

    fireEvent.click(await screen.findByRole('button', { name: 'Take it away' }));
    expect(screen.getByText(/checkout stop linking to it/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Take it away' }).at(-1)!);
    await waitFor(() =>
      expect(sentOf(fake, 'PolicyUpdate')).toEqual({
        shopPolicy: { type: 'SHIPPING_POLICY', body: '' },
      }),
    );
    cleanup();

    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/online-store/policies/refund-policy');
    expect(
      await screen.findByText("Only owners and managers set the shop's policies."),
    ).toBeTruthy();
  });
});
