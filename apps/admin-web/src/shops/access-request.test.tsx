import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';
import { handleOf } from './access-request-page';

describe('Asking a shop for access (ADR-488)', () => {
  beforeEach(() => signedIn());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('reads a shop handle from what is typed, its link or its name', () => {
    expect(handleOf(' https://Zari-Lawn.hatti.pk/products/kurta ')).toBe('zari-lawn');
    expect(handleOf('zari-lawn')).toBe('zari-lawn');
  });

  it('asks a shop by its link, then lists the requests and what became of them', async () => {
    let requests: unknown[] = [];
    const core = fakeCore(
      'owner',
      () => ({}),
      (path, _body, method) => {
        if (path !== '/auth/access-requests') throw new Error(`unexpected ${path}`);
        if (method === 'GET') return { requests };
        const request = {
          id: 'acr_1',
          shop: { name: 'Zari Lawn' },
          role: 'manager',
          accessDays: 90,
          message: 'Pixel Media',
          status: 'pending',
          createdAt: '2026-10-17T10:00:00Z',
          expiresAt: '2026-10-24T10:00:00Z',
        };
        requests = [request];
        return { request };
      },
    );
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/access');

    await screen.findByRole('heading', { name: 'Ask a shop for access' });
    type("Shop's address", 'https://zari-lawn.hatti.pk');
    type('Role', 'MANAGER');
    type('Access for', '90');
    type('Who you are, and what for', ' Pixel Media ');
    await press('Ask for access');
    await screen.findByText(
      'Asked Zari Lawn. Its owner decides within 7 days; you will see it below.',
    );
    expect(
      core.sent.find((each) => each.operation === '/auth/access-requests' && each.method === 'POST')
        ?.variables,
    ).toEqual({ shop: 'zari-lawn', role: 'manager', accessDays: 90, message: 'Pixel Media' });
    await screen.findByText('Waiting');
    expect(screen.getByText('Your requests')).toBeTruthy();
  });
});
