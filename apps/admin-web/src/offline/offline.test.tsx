import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../i18n/locale';
import { AppNotices } from './notices';
import { registerServiceWorker } from './register';
import { answerFor, precacheOf } from './rules';

const ORIGIN = 'https://admin.hatti.pk';
const get = (path: string, mode = 'cors') => ({ method: 'GET', mode, url: `${ORIGIN}${path}` });

const online = (value: boolean) => {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
  act(() => {
    window.dispatchEvent(new Event(value ? 'online' : 'offline'));
  });
};

describe('The admin installed and offline', () => {
  afterEach(() => {
    cleanup();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it("keeps the admin's own files and page, and never the shop's", () => {
    expect(answerFor(get('/shop_1/orders', 'navigate'), ORIGIN)).toBe('page');
    expect(answerFor(get('/assets/index-Bx81.js'), ORIGIN)).toBe('cache-first');
    expect(answerFor(get('/assets/noto-nastaliq-urdu-arabic-400.woff2'), ORIGIN)).toBe(
      'cache-first',
    );
    expect(answerFor(get('/icon-192.png'), ORIGIN)).toBe('cache-first');
    expect(answerFor(get('/manifest.ur.webmanifest'), ORIGIN)).toBe('cache-first');
    for (const path of ['/auth/me', '/admin/api/graphql.json', '/storage/f/1', '/robots.txt']) {
      expect(answerFor(get(path), ORIGIN)).toBe('network');
    }
    expect(answerFor(get('/auth/google', 'navigate'), ORIGIN)).toBe('network');
    expect(answerFor({ ...get('/assets/index-Bx81.js'), method: 'POST' }, ORIGIN)).toBe('network');
    expect(
      answerFor(
        { method: 'GET', mode: 'no-cors', url: 'https://accounts.google.com/gsi/client' },
        ORIGIN,
      ),
    ).toBe('network');

    expect(
      precacheOf([
        'index.html',
        'sw.js',
        'sw.js.map',
        'assets/index-Bx81.js',
        'assets/index-Bx81.js.map',
        'assets/index-C2aa.css',
        'assets/inter-latin-wght-normal-D4.woff2',
        'manifest.webmanifest',
        'manifest.ur.webmanifest',
        'icon.svg',
        'icon-192.png',
        'icon-192.png',
        'robots.txt',
      ]),
    ).toEqual([
      '/',
      '/assets/index-Bx81.js',
      '/assets/index-C2aa.css',
      '/icon-192.png',
      '/icon.svg',
      '/manifest.ur.webmanifest',
      '/manifest.webmanifest',
    ]);
  });

  it('says when the phone is offline, and offers a new version once it has installed', async () => {
    const postMessage = vi.fn();
    const listeners: Record<string, () => void> = {};
    const container = {
      controller: {},
      register: vi.fn(async () => ({
        waiting: { postMessage },
        addEventListener: vi.fn(),
        update: vi.fn(async () => undefined),
      })),
      addEventListener: vi.fn((type: string, listener: () => void) => {
        listeners[type] = listener;
      }),
    } as unknown as ServiceWorkerContainer;
    render(
      <LocaleProvider initial="en">
        <AppNotices />
      </LocaleProvider>,
    );
    expect(screen.queryByRole('status')).toBeNull();

    online(false);
    expect(screen.getByText(/You're offline/)).toBeTruthy();
    online(true);
    expect(screen.queryByText(/You're offline/)).toBeNull();

    await act(() => registerServiceWorker(container));
    expect(container.register).toHaveBeenCalledWith('/sw.js');
    expect(screen.getByText('A new version of Hatti is ready.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(postMessage).toHaveBeenCalledWith('take-over');
    expect(listeners.controllerchange).toBeTypeOf('function');
  });

  it('points the browser at the manifest in the language the admin is in', () => {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = '/manifest.webmanifest';
    document.head.append(link);
    render(
      <LocaleProvider initial="ur">
        <AppNotices />
      </LocaleProvider>,
    );
    expect(link.getAttribute('href')).toBe('/manifest.ur.webmanifest');
    cleanup();
    render(
      <LocaleProvider initial="en">
        <AppNotices />
      </LocaleProvider>,
    );
    expect(link.getAttribute('href')).toBe('/manifest.webmanifest');
    link.remove();
  });
});
