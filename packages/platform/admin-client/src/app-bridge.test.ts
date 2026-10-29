import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_BRIDGE_LIMITS,
  createAppBridge,
  envelopeOf,
  isAdminPath,
  requestIn,
  type AppBridgeWindow,
} from './app-bridge.js';

const ADMIN = 'https://admin.hatti.pk';

/** An app's page in the admin's frame: what it posts to the admin, and the admin's messages to it. */
function framed(search = `?shop=zari&embedded=1&host=${encodeURIComponent(ADMIN)}`) {
  const posted: { message: unknown; origin: string }[] = [];
  const parent = {
    postMessage: (message: unknown, origin: string) => posted.push({ message, origin }),
  };
  let listener: ((event: { data: unknown; origin: string; source: unknown }) => void) | null = null;
  const view: AppBridgeWindow = {
    location: { search },
    parent,
    addEventListener: (_type, given) => (listener = given),
    removeEventListener: () => (listener = null),
  };
  return {
    view,
    posted,
    /** A message posted to the page, by the admin unless said otherwise. */
    receive: (data: unknown, origin = ADMIN, source: unknown = parent) =>
      listener?.({ data, origin, source }),
    listening: () => listener !== null,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('App Bridge in an app opened inside the admin (DEV-06, ADR-912)', () => {
  it('asks the admin it was opened by for a fresh session token, and takes only its answer', async () => {
    const page = framed();
    const bridge = createAppBridge({ window: page.view });
    const token = bridge.idToken();
    expect(page.posted).toHaveLength(1);
    const { message, origin } = page.posted[0]!;
    expect(origin).toBe(ADMIN);
    const asked = message as { id: string; message: unknown };
    expect(asked).toMatchObject({
      bridge: 'hatti-app-bridge',
      version: 1,
      message: { type: 'id_token' },
    });
    // From another site, or another frame, or for another request: not the answer.
    page.receive(
      envelopeOf({ type: 'id_token', token: 'forged' }, asked.id),
      'https://evil.example',
    );
    page.receive(envelopeOf({ type: 'id_token', token: 'forged' }, asked.id), ADMIN, {});
    page.receive(envelopeOf({ type: 'id_token', token: 'other' }, 'not-asked'));
    page.receive(envelopeOf({ type: 'id_token', token: 'eyJ.fresh' }, asked.id));
    await expect(token).resolves.toBe('eyJ.fresh');
  });

  it('gives up on a token the admin never sends', async () => {
    vi.useFakeTimers();
    const bridge = createAppBridge({ window: framed().view });
    const token = bridge.idToken();
    vi.advanceTimersByTime(APP_BRIDGE_LIMITS.answerMs);
    await expect(token).rejects.toThrow('The admin did not answer with a session token');
  });

  it('shows toasts, goes to pages of the admin alone, and keeps the save bar', () => {
    const page = framed();
    const bridge = createAppBridge({ window: page.view });
    bridge.toast('Saved your settings');
    bridge.toast('x'.repeat(300), { error: true });
    bridge.navigate('/orders?status=open');
    expect(() => bridge.navigate('https://evil.example')).toThrow('Not a page of the admin');
    expect(() => bridge.navigate('//evil.example')).toThrow('Not a page of the admin');
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    bridge.saveBar.show({ onSave, onDiscard });
    page.receive(envelopeOf({ type: 'save' }));
    page.receive(envelopeOf({ type: 'discard' }), 'https://evil.example');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    bridge.saveBar.hide();
    page.receive(envelopeOf({ type: 'discard' }));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(page.posted.map(({ message }) => (message as { message: unknown }).message)).toEqual([
      { type: 'toast', message: 'Saved your settings', error: false },
      { type: 'toast', message: 'x'.repeat(APP_BRIDGE_LIMITS.toast), error: true },
      { type: 'navigate', path: '/orders?status=open' },
      { type: 'save_bar', visible: true },
      { type: 'save_bar', visible: false },
    ]);
    bridge.destroy();
    expect(page.listening()).toBe(false);
  });

  it('is made only inside an admin, on https or on this machine', () => {
    expect(() => createAppBridge({ window: framed('?shop=zari').view })).toThrow(
      'Opened outside the admin',
    );
    expect(() =>
      createAppBridge({ window: framed('?host=http%3A%2F%2Fadmin.hatti.pk').view }),
    ).toThrow("Not an admin's address");
    expect(() =>
      createAppBridge({ window: framed('?host=http%3A%2F%2Flocalhost%3A5173').view }),
    ).not.toThrow();
  });
});

describe("The admin's reading of what an app asks (ADR-912)", () => {
  it('reads requests it answers, and nothing else', () => {
    expect(requestIn(envelopeOf({ type: 'id_token' }, 't1'))).toEqual({
      id: 't1',
      request: { type: 'id_token' },
    });
    // A token asked for without an id can't be answered.
    expect(requestIn(envelopeOf({ type: 'id_token' }))).toBeNull();
    expect(requestIn(envelopeOf({ type: 'toast', message: '  Done  ' }))).toEqual({
      request: { type: 'toast', message: 'Done', error: false },
    });
    expect(requestIn(envelopeOf({ type: 'toast', message: ' ' }))).toBeNull();
    expect(requestIn(envelopeOf({ type: 'navigate', path: '/../billing' }))).toBeNull();
    expect(requestIn(envelopeOf({ type: 'save_bar', visible: 'yes' }))).toBeNull();
    expect(
      requestIn({ bridge: 'hatti-app-bridge', version: 2, message: { type: 'id_token' } }),
    ).toBeNull();
    expect(requestIn('hello')).toBeNull();
  });

  it('takes paths of the admin alone', () => {
    expect(isAdminPath('/products/123')).toBe(true);
    expect(isAdminPath('/')).toBe(true);
    for (const path of [
      'products',
      '//evil.example',
      '/a/../../b',
      '/javascript:alert(1)',
      '/a b',
    ]) {
      expect(isAdminPath(path), path).toBe(false);
    }
  });
});
