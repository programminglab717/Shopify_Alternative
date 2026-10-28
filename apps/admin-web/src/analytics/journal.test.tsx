import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalAccount, JournalLedger } from '../api/types';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const USUAL: [JournalAccount, string, string][] = [
  ['RECEIVABLE', '1200', 'Sales receivable'],
  ['SALES', '4000', 'Sales'],
  ['DISCOUNTS', '4010', 'Sales discounts'],
];

/** A fake core with the shop's journal and accounts; the page's other sections quiet. */
function core(role: 'accountant' | 'marketer' = 'accountant') {
  let ledgers: JournalLedger[] = USUAL.map(([account, code, name]) => ({
    account,
    code,
    name,
    named: false,
  }));
  let refuse = true;
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'AccountingJournalExport':
        return {
          accountingJournalExport: {
            file: {
              filename: 'journal-2026-09-28-to-2026-10-27-tally.xml',
              contentType: 'application/xml; charset=utf-8',
              content: btoa('<ENVELOPE/>'),
            },
            userErrors: [],
          },
        };
      case 'JournalLedgers':
        return { journalLedgers: ledgers };
      case 'JournalLedgersSet': {
        if (refuse) {
          refuse = false;
          return {
            journalLedgersSet: {
              journalLedgers: null,
              userErrors: [
                {
                  field: ['accounts', '0', 'name'],
                  code: 'TAKEN',
                  message: '"Sales receivable" is already another account\'s name',
                },
              ],
            },
          };
        }
        const given = variables.accounts as {
          account: JournalAccount;
          code: string;
          name: string;
        }[];
        ledgers = ledgers.map((each) => {
          const changed = given.find((one) => one.account === each.account);
          return changed ? { ...changed, named: true } : each;
        });
        return { journalLedgersSet: { journalLedgers: ledgers, userErrors: [] } };
      }
      default:
        throw new Error('not this time');
    }
  });
}

describe("The sales as a journal for the shop's books (ADR-885)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('downloads the period the page shows as a journal for Tally', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:journal');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderAdmin('/shop_1/analytics');

    const journal = (
      await screen.findByRole('heading', { name: 'Journal for your books' })
    ).closest('section')!;
    fireEvent.click(within(journal).getByRole('radio', { name: 'Tally' }));
    fireEvent.click(within(journal).getByRole('button', { name: 'Download the journal' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const [sent] = fake.sent.filter((each) => each.operation === 'AccountingJournalExport');
    expect(sent!.variables.format).toBe('TALLY');
    // The last 30 days, as the page shows them.
    expect(
      Date.parse(String(sent!.variables.placedBefore)) -
        Date.parse(String(sent!.variables.placedFrom)),
    ).toBe(30 * 86_400_000);
    // The accounts are asked for only once they are opened.
    expect(fake.sent.some((each) => each.operation === 'JournalLedgers')).toBe(false);
  });

  it('names the accounts as the books do, sending only those changed, or says why not', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/analytics');

    const journal = (
      await screen.findByRole('heading', { name: 'Journal for your books' })
    ).closest('section')!;
    const details = journal.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    const sales = (await within(journal).findByText('Sales')).closest('li')!;
    fireEvent.change(within(sales).getByLabelText('Code'), { target: { value: '41000' } });
    fireEvent.change(within(sales).getByLabelText('Name'), {
      target: { value: 'Sales receivable' },
    });
    fireEvent.click(within(journal).getByRole('button', { name: 'Save accounts' }));
    expect(
      await within(journal).findByText(
        `Sales: "Sales receivable" is already another account's name`,
      ),
    ).toBeTruthy();
    fireEvent.change(within(sales).getByLabelText('Name'), { target: { value: 'Online sales' } });
    fireEvent.click(within(journal).getByRole('button', { name: 'Save accounts' }));
    expect(
      await within(journal).findByText('Your accounts are saved. The next journal uses them.'),
    ).toBeTruthy();
    const saved = fake.sent.filter((each) => each.operation === 'JournalLedgersSet');
    expect(saved.at(-1)!.variables).toEqual({
      accounts: [{ account: 'SALES', code: '41000', name: 'Online sales' }],
    });
    expect(
      (within(journal).getByRole('button', { name: 'Save accounts' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('is not shown to those who do not export orders', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/analytics');
    await screen.findByRole('heading', { name: 'Analytics' });
    expect(screen.queryByRole('heading', { name: 'Journal for your books' })).toBeNull();
  });
});
