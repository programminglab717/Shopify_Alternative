import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READS_ANALYTICS } from '../analytics/analytics-page';
import { RECONCILES_CASH } from '../cash/cash-page';
import { KEEPS_SEGMENTS, READS_CUSTOMERS, REVEALS_NUMBERS } from '../customers/customers-page';
import { KEEPS_BLOCKLIST } from '../customers/blocked-page';
import { MOVES_CREDIT, READS_CREDIT } from '../customers/store-credit';
import { MOVES_CUSTOMERS } from '../customers/transfer-page';
import { SEES_AGENTS } from '../desk/agents-page';
import { MANAGES_DISCOUNTS } from '../discounts/discounts-page';
import { TAKES_DRAFTS } from '../drafts/drafts-page';
import { READS_INBOX, WORKS_INBOX } from '../inbox/inbox-page';
import { MARKETS } from '../marketing/broadcasts-page';
import { EDITS_MENUS } from '../online-store/menus';
import { SETS_META } from '../online-store/meta';
import { OPENS_ONLINE_STORE } from '../online-store/online-store-page';
import { WRITES_BLOGS, WRITES_PAGES } from '../online-store/pages';
import { SETS_POLICIES } from '../online-store/policies';
import { EDITS_THEMES } from '../online-store/themes';
import { SEES_ABANDONED } from '../orders/abandoned-page';
import { SENDS_LINKS } from '../orders/customer-link';
import { EXPORTS_ORDERS } from '../orders/export-page';
import { HANDLES_MONEY, REFUNDS } from '../orders/money';
import { SAVES_ORDER_SEARCHES } from '../orders/orders-page';
import { SEES_PACKERS, SEES_PACKING } from '../orders/packers-page';
import { WORKS_PARCELS } from '../orders/parcels';
import { MAKES_PAYMENT_LINKS } from '../payment-links/payment-links-page';
import { READS_GIFT_CARDS } from '../products/gift-cards-page';
import { EDITS_PRODUCTS } from '../products/status';
import { CHECKS_IN, CLAIMS, READS_RETURNS } from '../returns/parcel';
import { MANAGES_STAFF, OPENS_SETTINGS, SETS_SETTINGS } from '../settings/settings-page';
import { sectionsOf } from '../shell/shell';
import { EDITS_STOCK, SEES_STOCK_WORTH } from '../stock/stock-page';
import { fakeCore, presetAccess, renderAdmin, signedIn } from '../test-support';
import { WRITES_URDU } from '../urdu/in-urdu';
import { can, hasCapability, permits, type Gate } from './permissions';
import type { ShopAccess, StaffRole } from './session';

const ROLES: readonly StaffRole[] = [
  'owner',
  'manager',
  'confirmation_agent',
  'packer',
  'marketer',
  'accountant',
];

const GATES: Record<string, Gate> = {
  READS_ANALYTICS,
  RECONCILES_CASH,
  KEEPS_SEGMENTS,
  READS_CUSTOMERS,
  REVEALS_NUMBERS,
  KEEPS_BLOCKLIST,
  MOVES_CREDIT,
  READS_CREDIT,
  MOVES_CUSTOMERS,
  SEES_AGENTS,
  MANAGES_DISCOUNTS,
  TAKES_DRAFTS,
  READS_INBOX,
  WORKS_INBOX,
  MARKETS,
  EDITS_MENUS,
  SETS_META,
  OPENS_ONLINE_STORE,
  WRITES_BLOGS,
  WRITES_PAGES,
  SETS_POLICIES,
  EDITS_THEMES,
  SEES_ABANDONED,
  SENDS_LINKS,
  EXPORTS_ORDERS,
  HANDLES_MONEY,
  REFUNDS,
  SAVES_ORDER_SEARCHES,
  SEES_PACKERS,
  SEES_PACKING,
  WORKS_PARCELS,
  MAKES_PAYMENT_LINKS,
  READS_GIFT_CARDS,
  EDITS_PRODUCTS,
  CHECKS_IN,
  CLAIMS,
  READS_RETURNS,
  MANAGES_STAFF,
  OPENS_SETTINGS,
  SETS_SETTINGS,
  EDITS_STOCK,
  SEES_STOCK_WORTH,
  WRITES_URDU,
};

/** A manager on a custom role made from the manager's preset, holding `scopes` and `capabilities`. */
const lead = (scopes: string[], capabilities: string[]): Partial<ShopAccess> => ({
  role: 'manager',
  mfaRequired: true,
  scopes,
  capabilities,
  customRole: { id: 'role_1', name: 'Lead' },
});

describe('What a member may do in a shop (ADR-580)', () => {
  it('reads scopes as the core does, a write holding the read', () => {
    const shop = { role: 'marketer' as const, scopes: ['write_pixels'], capabilities: [] };
    expect(can(shop, 'write_pixels')).toBe(true);
    expect(can(shop, 'read_pixels')).toBe(true);
    expect(can(shop, 'read_orders')).toBe(false);
    expect(hasCapability(shop, 'export_orders')).toBe(false);
    expect(hasCapability({ ...shop, capabilities: ['export_orders'] }, 'export_orders')).toBe(true);
  });

  it('lets a session the core told only the role in by its role', () => {
    expect(permits({ role: 'accountant' }, EXPORTS_ORDERS)).toBe(true);
    expect(permits({ role: 'packer' }, EXPORTS_ORDERS)).toBe(false);
    // Told what they hold, a member passes by it, within the roles the gate is for.
    expect(permits({ role: 'accountant', scopes: [], capabilities: [] }, EXPORTS_ORDERS)).toBe(
      false,
    );
    expect(
      permits({ role: 'packer', scopes: [], capabilities: ['export_orders'] }, EXPORTS_ORDERS),
    ).toBe(false);
  });

  it("shows each preset's member what their role showed them before", () => {
    for (const role of ROLES) {
      for (const [name, gate] of Object.entries(GATES)) {
        expect([name, role, permits(presetAccess(role), gate)]).toEqual([
          name,
          role,
          permits({ role }, gate),
        ]);
      }
      expect(sectionsOf(presetAccess(role)).map((item) => item.to)).toEqual(
        sectionsOf(role).map((item) => item.to),
      );
    }
  });

  it("hides the sections a custom role's member cannot open", () => {
    const sections = (shop: Partial<ShopAccess>) =>
      sectionsOf({ ...presetAccess('manager'), ...shop }).map((item) => item.label);
    expect(sections(lead(['write_orders'], ['assign_orders']))).toEqual([
      'nav.home',
      'nav.orders',
      'nav.desk',
      'nav.shipping',
      'nav.returns',
      // Selling at the till, as they change orders (ADR-872).
      'nav.pos',
      'nav.products',
      'nav.stock',
      'nav.paymentLinks',
      'nav.analytics',
      'nav.help',
    ]);
    // Settings open to one who manages staff, though they change no other setting.
    expect(sections(lead(['read_settings'], ['manage_staff']))).toContain('nav.settings');
    expect(sections(lead(['read_orders'], ['reconcile_payments']))).toContain('nav.cash');
    expect(sections(lead(['read_orders'], []))).not.toContain('nav.cash');
    expect(sections(lead(['read_orders'], []))).not.toContain('nav.pos');
  });
});

describe("A custom role's member in the admin (ADR-580)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const staffCore = (shop: Partial<ShopAccess>) =>
    fakeCore(
      'manager',
      (operation) => {
        switch (operation) {
          case 'Staff':
            return {
              staffMembers: [
                {
                  id: 'usr_1',
                  name: 'Sana',
                  email: null,
                  role: 'MANAGER',
                  customRole: { id: 'role_1', name: 'Lead', basedOn: 'MANAGER' },
                  joinedAt: new Date().toISOString(),
                },
                {
                  id: 'usr_9',
                  name: 'Bilal',
                  email: null,
                  role: 'PACKER',
                  customRole: null,
                  joinedAt: new Date().toISOString(),
                },
              ],
              staffInvitations: [],
            };
          case 'Orders':
            return {
              orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              orderStageCounts: [],
            };
          default:
            throw new Error(`unexpected ${operation}`);
        }
      },
      () => ({}),
      { shop },
    );

  it('shows staff to a manager without manage_staff, but not their roles or invitations', async () => {
    const fake = staffCore(lead(['write_settings'], []));
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/staff');

    expect(await screen.findByText('Bilal')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Roles' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Invite someone' })).toBeNull();
    expect(fake.sent.map((each) => each.operation)).not.toContain('CustomRoles');
    cleanup();

    // With it, as a manager does.
    vi.stubGlobal('fetch', staffCore(lead(['write_settings'], ['manage_staff'])).fetcher);
    renderAdmin('/shop_1/settings/staff');
    expect(await screen.findByRole('tab', { name: 'Roles' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Invite someone' })).toBeTruthy();
  });

  it('leaves exports to those who hold export_orders', async () => {
    vi.stubGlobal('fetch', staffCore(lead(['write_orders'], ['assign_orders'])).fetcher);
    renderAdmin('/shop_1/orders');
    expect(await screen.findByRole('heading', { name: 'Orders' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Export' })).toBeNull();
    cleanup();

    vi.stubGlobal('fetch', staffCore(lead(['write_orders'], ['export_orders'])).fetcher);
    renderAdmin('/shop_1/orders');
    expect(await screen.findByRole('link', { name: 'Export' })).toBeTruthy();
  });

  it('lists the settings a member can use, and hides settings from one who uses none', async () => {
    vi.stubGlobal('fetch', staffCore(lead(['read_settings'], ['manage_staff'])).fetcher);
    renderAdmin('/shop_1/settings');
    const list = (await screen.findByRole('link', { name: /^Staff/ })).closest('ul')!;
    expect(
      within(list)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([expect.stringMatching(/^Staff/), expect.stringMatching(/^Activity/)]);
    // The sidebar's, the first of the shell's.
    const sidebar = () => screen.getAllByRole('navigation', { name: 'Main' })[0]!;
    expect(within(sidebar()).getByRole('link', { name: 'Settings' })).toBeTruthy();
    cleanup();

    vi.stubGlobal('fetch', staffCore(lead(['write_orders'], [])).fetcher);
    renderAdmin('/shop_1/orders');
    await screen.findByRole('heading', { name: 'Orders' });
    const nav = sidebar();
    expect(within(nav).getByRole('link', { name: 'Orders' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Customers' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Online store' })).toBeNull();
  });
});
