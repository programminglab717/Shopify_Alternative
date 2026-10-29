import { Save } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { CustomerCreditLimitSetMutation, CustomerCreditQuery } from '../api/operations';
import type { CustomerCreditData, CustomerCreditLimitSetData } from '../api/types';
import { gate, permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopDetails } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';

/** Those who see a customer's credit on payment terms (ADR-907), as they see what is owed. */
export const READS_TERMS_CREDIT = gate(['owner', 'manager', 'accountant'], 'read_orders');

/** Those who set a customer's credit limit: owners and managers. */
const SETS_CREDIT_LIMIT = gate(['owner', 'manager'], 'write_orders');

/** An amount as the core gives it, "200000.00", as a merchant types it, "200000". */
const rupeesOf = (amount: string) => amount.replace(/\.00$/, '');

/**
 * A wholesale customer's credit on payment terms (CUS-06, ADR-907): what they owe on terms and
 * what of it is overdue, and the most they may owe, which an order on terms may not go past.
 */
export function CreditLimit({ customerId }: { customerId: string }) {
  const { t } = useLocale();
  const access = useShop();
  const currency = useShopDetails()?.currencyCode ?? 'PKR';
  const query = useAdminQuery<CustomerCreditData>(
    ['customerCredit', customerId],
    CustomerCreditQuery,
    { customerId },
  );
  const set = useAdminMutation<CustomerCreditLimitSetData, Record<string, unknown>>(
    CustomerCreditLimitSetMutation,
  );
  const [limit, setLimit] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const credit = query.data?.customerCredit;
  const kept = credit?.creditLimit ? rupeesOf(credit.creditLimit.amount) : '';
  const shown = limit ?? kept;
  const sets = permits(access, SETS_CREDIT_LIMIT);

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    try {
      const { customerCreditLimitSet } = await set.mutateAsync({
        customerId,
        creditLimit: shown.trim() || null,
      });
      const error = customerCreditLimitSet.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return;
      }
      setLimit(null);
      setSaved(true);
      await query.refetch();
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('termsCredit.title')} hint={t('termsCredit.hint')}>
      {query.isError && <Alert tone="danger">{errorText(query.error, t)}</Alert>}
      {credit && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
          <dt className="text-secondary">{t('termsCredit.owed')}</dt>
          <dd className="num font-semibold">{formatMoney(credit.owed.amount, currency)}</dd>
          <dt className="text-secondary">{t('termsCredit.overdue')}</dt>
          <dd className={`num ${Number(credit.overdue.amount) > 0 ? 'text-danger' : ''}`}>
            {formatMoney(credit.overdue.amount, currency)}
          </dd>
        </dl>
      )}
      {credit && sets && (
        <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
          <TextField
            label={t('termsCredit.limit')}
            hint={t('termsCredit.limitHint')}
            inputMode="decimal"
            ltr
            value={shown}
            onChange={(event) => {
              setSaved(false);
              setLimit(event.target.value);
            }}
          />
          {problem && <Alert tone="danger">{problem}</Alert>}
          {saved && <Alert tone="success">{t('termsCredit.saved')}</Alert>}
          <Button
            type="submit"
            variant="secondary"
            className="self-start"
            busy={set.isPending}
            disabled={shown.trim() === kept}
            icon={<Save aria-hidden className="size-5" />}
          >
            {t('termsCredit.save')}
          </Button>
        </form>
      )}
      {credit && !sets && (
        <p className="text-secondary">
          {credit.creditLimit
            ? t('termsCredit.limitIs', { limit: formatMoney(credit.creditLimit.amount, currency) })
            : t('termsCredit.none')}
        </p>
      )}
    </FormSection>
  );
}
