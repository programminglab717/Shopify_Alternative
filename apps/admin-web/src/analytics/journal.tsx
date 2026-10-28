/**
 * The period's sales as a journal for the shop's books (ANL-10, ADR-885): an entry a day, for
 * Xero, QuickBooks or Tally to import or as a CSV, posted to the accounts the shop names.
 */
import { Download } from 'lucide-react';
import { useState } from 'react';
import {
  AccountingJournalExportMutation,
  JournalLedgersQuery,
  JournalLedgersSetMutation,
} from '../api/operations';
import type {
  AccountingJournalExportData,
  JournalAccount,
  JournalFormat,
  JournalLedger,
  JournalLedgersData,
  JournalLedgersSetData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { save } from '../orders/export-page';
import { FormSection } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

export const JOURNAL_FORMATS: readonly JournalFormat[] = ['CSV', 'XERO', 'QUICKBOOKS', 'TALLY'];

/** Each account, as merchants know it. */
const ACCOUNT_LABELS: Readonly<Record<JournalAccount, MessageKey>> = {
  RECEIVABLE: 'journal.account.RECEIVABLE',
  SALES: 'journal.account.SALES',
  DISCOUNTS: 'journal.account.DISCOUNTS',
  RETURNS: 'journal.account.RETURNS',
  SHIPPING: 'journal.account.SHIPPING',
  FEES: 'journal.account.FEES',
  SALES_TAX: 'journal.account.SALES_TAX',
  COST_OF_GOODS: 'journal.account.COST_OF_GOODS',
  INVENTORY: 'journal.account.INVENTORY',
  BANK: 'journal.account.BANK',
  COURIER_CHARGES: 'journal.account.COURIER_CHARGES',
  COURIERS: 'journal.account.COURIERS',
  WRITE_OFFS: 'journal.account.WRITE_OFFS',
  CLAIMS: 'journal.account.CLAIMS',
};

/** The accounts as the shop's books know them, each to be named and numbered. */
function Accounts({ ledgers }: { ledgers: JournalLedger[] }) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(ledgers.map((each) => [each.account, { code: each.code, name: each.name }])),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const saving = useAdminMutation<JournalLedgersSetData, Record<string, unknown>>(
    JournalLedgersSetMutation,
  );
  const changed = ledgers.filter(
    (each) =>
      draft[each.account]!.code.trim() !== each.code ||
      draft[each.account]!.name.trim() !== each.name,
  );

  const submit = async () => {
    setProblem(null);
    setSaved(false);
    try {
      const { journalLedgersSet } = await saving.mutateAsync({
        accounts: changed.map((each) => ({ account: each.account, ...draft[each.account]! })),
      });
      const error = journalLedgersSet.userErrors[0];
      if (error || !journalLedgersSet.journalLedgers) {
        const index = Number(error?.field?.[1]);
        const account = Number.isInteger(index) ? changed[index]?.account : undefined;
        setProblem(
          `${account ? `${t(ACCOUNT_LABELS[account])}: ` : ''}${error?.message ?? t('state.error')}`,
        );
        return;
      }
      setDraft(
        Object.fromEntries(
          journalLedgersSet.journalLedgers.map((each) => [
            each.account,
            { code: each.code, name: each.name },
          ]),
        ),
      );
      setSaved(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-secondary">{t('journal.accountsHint')}</p>
      <ul className="flex flex-col divide-y divide-line">
        {ledgers.map((each) => (
          <li key={each.account} className="grid gap-2 py-3 sm:grid-cols-[1fr_8rem_1.5fr]">
            <span className="font-medium sm:self-center">{t(ACCOUNT_LABELS[each.account])}</span>
            <TextField
              label={t('journal.code')}
              ltr
              maxLength={20}
              value={draft[each.account]!.code}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  [each.account]: { ...draft[each.account]!, code: event.target.value },
                })
              }
            />
            <TextField
              label={t('journal.name')}
              maxLength={100}
              value={draft[each.account]!.name}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  [each.account]: { ...draft[each.account]!, name: event.target.value },
                })
              }
            />
          </li>
        ))}
      </ul>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {saved && <Alert tone="success">{t('journal.saved')}</Alert>}
      <div>
        <Button type="submit" busy={saving.isPending} disabled={changed.length === 0}>
          {t('journal.save')}
        </Button>
      </div>
    </form>
  );
}

/** The journal of the period the page shows, for those who may export orders. */
export function Journal({ from, before }: { from: string; before: string }) {
  const { t } = useLocale();
  const [format, setFormat] = useState<JournalFormat>('CSV');
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const exporting = useAdminMutation<AccountingJournalExportData, Record<string, unknown>>(
    AccountingJournalExportMutation,
  );
  const ledgers = useAdminQuery<JournalLedgersData>(
    ['journalLedgers'],
    JournalLedgersQuery,
    undefined,
    { enabled: open },
  );

  const download = async () => {
    setProblem(null);
    try {
      const { accountingJournalExport } = await exporting.mutateAsync({
        placedFrom: from,
        placedBefore: before,
        format,
      });
      const error = accountingJournalExport.userErrors[0];
      if (error || !accountingJournalExport.file) {
        setProblem(error?.message ?? t('state.error'));
        return;
      }
      save(accountingJournalExport.file);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('journal.title')} hint={t('journal.hint')}>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-medium">{t('journal.format')}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {JOURNAL_FORMATS.map((each) => (
            <label key={each} className="flex min-h-10 items-center gap-2">
              <input
                type="radio"
                name="journal-format"
                value={each}
                checked={format === each}
                onChange={() => setFormat(each)}
              />
              {t(`journal.format.${each}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <Button
          variant="secondary"
          busy={exporting.isPending}
          icon={<Download aria-hidden className="size-5" />}
          onClick={() => void download()}
        >
          {t('journal.download')}
        </Button>
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="min-h-10 cursor-pointer py-2 font-medium">
          {t('journal.accounts')}
        </summary>
        {ledgers.isError ? (
          <Alert tone="danger">{errorText(ledgers.error, t)}</Alert>
        ) : ledgers.data ? (
          <Accounts ledgers={ledgers.data.journalLedgers} />
        ) : (
          open && <Loading label={t('state.loading')} />
        )}
      </details>
    </FormSection>
  );
}
