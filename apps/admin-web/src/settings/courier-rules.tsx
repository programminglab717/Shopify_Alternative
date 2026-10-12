import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { CourierRulesQuery, CourierRulesUpdateMutation } from '../api/operations';
import type {
  CourierAccountDetail,
  CourierRulesData,
  CourierRulesUpdateData,
  CourierRuleValue,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** A rule as it is edited: cities as typed, comma apart, and amounts as typed. */
interface Draft {
  key: string;
  accountId: string;
  cities: string;
  codAtLeast: string;
  codBelow: string;
}

let drafted = 0;
const keyed = () => `rule-${++drafted}`;

/** An amount as a field shows it: "20000" for Rs 20,000, blank for none. */
function amountText(value: CourierRuleValue['codAtLeast']): string {
  return value ? String(Number(value.amount)) : '';
}

function draftOf(rule: CourierRuleValue): Draft {
  return {
    key: rule.id,
    accountId: rule.accountId,
    cities: rule.cities.join(', '),
    codAtLeast: amountText(rule.codAtLeast),
    codBelow: amountText(rule.codBelow),
  };
}

/** A courier account by its name, with its courier where the name is the shop's own. */
function accountLabel(account: CourierAccountDetail): string {
  return account.name === account.courierName
    ? account.name
    : `${account.name} (${account.courierName})`;
}

/** One rule being edited: its account, cities and cash to collect, moved or taken away. */
function RuleEditor({
  draft,
  index,
  count,
  accounts,
  archived,
  onChange,
  onMove,
  onRemove,
}: {
  draft: Draft;
  index: number;
  count: number;
  accounts: CourierAccountDetail[];
  archived: boolean;
  onChange: (draft: Draft) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  const accountField = useId();
  const number = index + 1;
  return (
    <li
      aria-label={t('courierRules.rule', { number })}
      className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 font-semibold">{t('courierRules.rule', { number })}</span>
        <Button
          variant="tertiary"
          icon={<ArrowUp aria-hidden className="size-5" />}
          aria-label={t('courierRules.up', { number })}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        />
        <Button
          variant="tertiary"
          icon={<ArrowDown aria-hidden className="size-5" />}
          aria-label={t('courierRules.down', { number })}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        />
        <Button
          variant="tertiary"
          icon={<Trash2 aria-hidden className="size-5" />}
          aria-label={t('courierRules.remove', { number })}
          onClick={onRemove}
        />
      </div>
      {archived && <Alert tone="warning">{t('courierRules.archived')}</Alert>}
      <TextField
        label={t('courierRules.cities')}
        hint={t('courierRules.citiesHint')}
        value={draft.cities}
        onChange={(event) => onChange({ ...draft, cities: event.target.value })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t('courierRules.codAtLeast')}
          inputMode="decimal"
          value={draft.codAtLeast}
          onChange={(event) => onChange({ ...draft, codAtLeast: event.target.value })}
        />
        <TextField
          label={t('courierRules.codBelow')}
          inputMode="decimal"
          value={draft.codBelow}
          onChange={(event) => onChange({ ...draft, codBelow: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={accountField} className="font-medium">
          {t('courierRules.bookWith')}
        </label>
        <select
          id={accountField}
          value={draft.accountId}
          onChange={(event) => onChange({ ...draft, accountId: event.target.value })}
          className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
        >
          {archived && <option value={draft.accountId}>{t('courierRules.archivedAccount')}</option>}
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {accountLabel(account)}
            </option>
          ))}
        </select>
      </div>
    </li>
  );
}

/**
 * The shop's courier rules (SHP-06, ADR-382): when staff book without choosing an account, an
 * order goes with the first rule its city and cash to collect match, the rest with the default
 * account. Edited all together, in their order, and saved at once.
 */
export function CourierRules({ accounts }: { accounts: CourierAccountDetail[] }) {
  const { t } = useLocale();
  const query = useAdminQuery<CourierRulesData>(['courierRules'], CourierRulesQuery);
  const save = useAdminMutation<CourierRulesUpdateData, { rules: Record<string, unknown>[] }>(
    CourierRulesUpdateMutation,
  );
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const fallback = accounts.find((account) => account.isDefault);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const rules = query.data.courierRules;
  const archivedIds = new Set(
    rules.filter((rule) => rule.accountArchived).map((rule) => rule.accountId),
  );
  const editing = drafts ?? rules.map(draftOf);
  const change = (next: Draft[]) => {
    setDrafts(next);
    setSaved(false);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblems([]);
    try {
      const { courierRulesUpdate } = await save.mutateAsync({
        rules: editing.map((draft) => ({
          accountId: draft.accountId,
          cities: draft.cities
            .split(/[,،\n]/)
            .map((city) => city.trim())
            .filter(Boolean),
          codAtLeast: draft.codAtLeast.trim() || null,
          codBelow: draft.codBelow.trim() || null,
        })),
      });
      if (courierRulesUpdate.userErrors.length > 0) {
        setProblems(
          courierRulesUpdate.userErrors.map((error) => {
            const at = error.field?.[0] === 'rules' ? Number(error.field[1]) : NaN;
            return Number.isNaN(at)
              ? error.message
              : `${t('courierRules.rule', { number: at + 1 })}: ${error.message}`;
          }),
        );
        return;
      }
      setDrafts(null);
      setSaved(true);
      await query.refetch();
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold">{t('courierRules.title')}</h2>
          <p className="text-secondary">
            {fallback
              ? t('courierRules.hint', { account: accountLabel(fallback) })
              : t('courierRules.hintNoDefault')}
          </p>
        </div>
        {saved && <Alert tone="success">{t('courierRules.saved')}</Alert>}
        {problems.length > 0 && (
          <Alert tone="danger">
            <ul className="list-disc ps-5">
              {problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}
        {editing.length === 0 ? (
          <p className="text-secondary">{t('courierRules.none')}</p>
        ) : (
          <ol aria-label={t('courierRules.title')} className="flex flex-col divide-y divide-line">
            {editing.map((draft, index) => (
              <RuleEditor
                key={draft.key}
                draft={draft}
                index={index}
                count={editing.length}
                accounts={accounts}
                archived={archivedIds.has(draft.accountId)}
                onChange={(next) => change(editing.map((each, at) => (at === index ? next : each)))}
                onMove={(by) => {
                  const next = [...editing];
                  const [moved] = next.splice(index, 1);
                  next.splice(index + by, 0, moved!);
                  change(next);
                }}
                onRemove={() => change(editing.filter((_, at) => at !== index))}
              />
            ))}
          </ol>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() =>
              change([
                ...editing,
                {
                  key: keyed(),
                  accountId: accounts[0]?.id ?? '',
                  cities: '',
                  codAtLeast: '',
                  codBelow: '',
                },
              ])
            }
          >
            {t('courierRules.add')}
          </Button>
          {drafts !== null && (
            <>
              <Button type="submit" busy={save.isPending}>
                {t('courierRules.save')}
              </Button>
              <Button
                variant="tertiary"
                onClick={() => {
                  setDrafts(null);
                  setProblems([]);
                }}
              >
                {t('courierRules.discard')}
              </Button>
            </>
          )}
        </div>
      </form>
    </Card>
  );
}
