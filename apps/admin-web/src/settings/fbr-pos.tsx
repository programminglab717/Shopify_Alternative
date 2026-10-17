import { Link } from '@tanstack/react-router';
import type { OrderStage as BadgeColour } from '@hatti/tokens';
import type { LucideIcon } from 'lucide-react';
import { CircleCheck, CircleOff, CircleX, Clock, Link2Off, RotateCw, Save } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  FbrPosDeleteMutation,
  FbrPosQuery,
  FbrPosUpdateMutation,
  FiscalInvoiceRetryMutation,
  FiscalInvoicesQuery,
} from '../api/operations';
import type {
  FbrEnvironment,
  FbrPos,
  FbrPosData,
  FbrPosDeleteData,
  FbrPosUpdateData,
  FiscalInvoice,
  FiscalInvoiceRetryData,
  FiscalInvoicesData,
  FiscalInvoiceStatus,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { Problems, SelectField, settingProblem } from './settings-form';
import { OPENS_SETTINGS } from './settings-page';

const ENVIRONMENTS: readonly FbrEnvironment[] = ['SANDBOX', 'PRODUCTION'];

/** What the form sends, each of which FBR's userErrors may name. */
const FIELDS = ['posId', 'accessToken', 'environment', 'pctCode'] as const;
type Field = (typeof FIELDS)[number];

const LABELS: Partial<Record<string, MessageKey>> = {
  posId: 'fbr.posId',
  accessToken: 'fbr.accessToken',
  environment: 'fbr.environment',
  pctCode: 'fbr.pctCode',
};

/** The invoices listed: all of them, or those of one status. */
const STATUSES = ['ALL', 'PENDING', 'REPORTED', 'FAILED', 'SKIPPED'] as const;
type StatusChoice = (typeof STATUSES)[number];

/** How each status shows: reported in green, waiting in amber, refused in red, not sent in grey. */
const STATUS_BADGES: Record<FiscalInvoiceStatus, { colour: BadgeColour; icon: LucideIcon }> = {
  REPORTED: { colour: 'delivered', icon: CircleCheck },
  PENDING: { colour: 'needsConfirmation', icon: Clock },
  FAILED: { colour: 'deliveryIssue', icon: CircleX },
  SKIPPED: { colour: 'cancelled', icon: CircleOff },
};

/** A PCT code's 8 digits as FBR's tariff writes them: "6204.4200". */
function pctText(code: string): string {
  return /^\d{8}$/.test(code) ? `${code.slice(0, 4)}.${code.slice(4)}` : code;
}

/** A PCT code as typed, its dots and spaces aside, to compare with the one kept. */
function pctDigits(text: string): string {
  return text.replace(/[\s.]/g, '');
}

/**
 * Connecting the shop's POS to FBR, or changing what it gave: the POS ID, the access token FBR
 * gave with it, sealed and never shown again, FBR's sandbox or production, and the PCT code its
 * items are reported under. Only what changed is sent, once the member confirms who they are; a
 * problem FBR's fields name shows under that field.
 */
function FbrForm({ current }: { current: FbrPos | null }) {
  const { t } = useLocale();
  const update = useAdminMutation<FbrPosUpdateData, { input: Record<string, unknown> }>(
    FbrPosUpdateMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const radios = useId();
  const [posId, setPosId] = useState(current ? String(current.posId) : '');
  const [accessToken, setAccessToken] = useState('');
  const [environment, setEnvironment] = useState<FbrEnvironment>(current?.environment ?? 'SANDBOX');
  const [pctCode, setPctCode] = useState(current ? pctText(current.pctCode) : '');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const posIdChanged = posId.trim() !== (current ? String(current.posId) : '');
  const changes: Record<string, unknown> = {
    ...(posIdChanged && { posId: Number(posId.trim()) }),
    ...(accessToken.trim() && { accessToken: accessToken.trim() }),
    ...((!current || environment !== current.environment) && { environment }),
    ...(pctDigits(pctCode) !== (current?.pctCode ?? '') && { pctCode: pctCode.trim() }),
  };
  const changed = current ? Object.keys(changes).length > 0 : true;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setProblems([]);
    setSaved(false);
    if (posIdChanged && !/^\d{1,10}$/.test(posId.trim())) {
      setErrors({ posId: t('fbr.badPosId') });
      return;
    }
    setErrors({});
    void run(
      async () => {
        const { fbrPosUpdate } = await update.mutateAsync({ input: changes });
        const kept = fbrPosUpdate.fbrPos;
        if (fbrPosUpdate.userErrors.length > 0 || !kept) {
          const under: Partial<Record<Field, string>> = {};
          const general: string[] = [];
          for (const error of fbrPosUpdate.userErrors) {
            const field = error.field ?? [];
            const named = field[1] as Field | undefined;
            if (field.length === 2 && field[0] === 'input' && named && FIELDS.includes(named)) {
              under[named] = error.message;
            } else general.push(settingProblem(error, t, LABELS));
          }
          setErrors(under);
          setProblems(general);
          return;
        }
        setPosId(String(kept.posId));
        setAccessToken('');
        setEnvironment(kept.environment);
        setPctCode(pctText(kept.pctCode));
        setSaved(true);
      },
      (failure) => setProblems([errorText(failure, t)]),
    );
  };

  const form = (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <TextField
        label={t('fbr.posId')}
        hint={t('fbr.posIdHint')}
        inputMode="numeric"
        autoComplete="off"
        ltr
        className="max-w-xs"
        required={!current}
        error={errors.posId}
        value={posId}
        onChange={(event) => setPosId(event.target.value)}
      />
      <TextField
        label={current ? t('fbr.newAccessToken') : t('fbr.accessToken')}
        hint={
          current
            ? t('fbr.accessTokenKept', { hint: current.accessTokenHint })
            : t('fbr.accessTokenHint')
        }
        type="password"
        autoComplete="off"
        ltr
        required={!current}
        error={errors.accessToken}
        value={accessToken}
        onChange={(event) => setAccessToken(event.target.value)}
      />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-medium">{t('fbr.environment')}</legend>
        {ENVIRONMENTS.map((each) => (
          <label key={each} className="flex min-h-10 items-start gap-2 py-1">
            <input
              type="radio"
              name={radios}
              checked={environment === each}
              onChange={() => setEnvironment(each)}
              className="mt-1 size-5 shrink-0 accent-[var(--hatti-color-primary)]"
            />
            <span className="flex flex-col">
              <span>{t(`fbr.environment.${each}` as MessageKey)}</span>
              <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {t(`fbr.environment.${each}.hint` as MessageKey)}
              </span>
            </span>
          </label>
        ))}
        {errors.environment && (
          <p className="text-danger text-[length:var(--hatti-type-body-sm-size)]">
            {errors.environment}
          </p>
        )}
      </fieldset>
      <TextField
        label={t('fbr.pctCode')}
        hint={t('fbr.pctCodeHint')}
        inputMode="decimal"
        autoComplete="off"
        ltr
        className="max-w-xs"
        required={!current}
        error={errors.pctCode}
        value={pctCode}
        onChange={(event) => setPctCode(event.target.value)}
      />
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('couriers.sealed')}
      </p>
      <Problems problems={problems} />
      {saved && current && !changed && <Alert tone="success">{t('fbr.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={update.isPending}
        disabled={!changed}
        icon={<Save aria-hidden className="size-5" />}
      >
        {current ? t('fbr.save') : t('fbr.connect')}
      </Button>
    </form>
  );
  // Confirming who they are has a form of its own, so it sits beside this one, not in it.
  return (
    <>
      {form}
      {panel}
    </>
  );
}

/** What the shop's POS gave FBR, its token as its last four characters alone. */
function Connected({ pos }: { pos: FbrPos }) {
  const { t } = useLocale();
  const rows: { label: MessageKey; value: string; ltr: boolean }[] = [
    { label: 'fbr.posId', value: String(pos.posId), ltr: true },
    { label: 'fbr.accessToken', value: `•••• ${pos.accessTokenHint}`, ltr: true },
    {
      label: 'fbr.environment',
      value: t(`fbr.environment.${pos.environment}` as MessageKey),
      ltr: false,
    },
    { label: 'fbr.pctCode', value: pctText(pos.pctCode), ltr: true },
  ];
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="success">{t('fbr.connected')}</Alert>
      {pos.environment === 'SANDBOX' && <Alert tone="warning">{t('fbr.sandboxNote')}</Alert>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-secondary">{t(row.label)}</dt>
            <dd className={row.ltr ? 'num' : undefined} dir={row.ltr ? 'ltr' : undefined}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Disconnecting FBR, once asked whether they mean it. */
function Disconnect({ posId }: { posId: number }) {
  const { t } = useLocale();
  const remove = useAdminMutation<FbrPosDeleteData, Record<string, never>>(FbrPosDeleteMutation);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onDisconnect = async () => {
    setProblem(null);
    try {
      const { fbrPosDelete } = await remove.mutateAsync({});
      const error = fbrPosDelete.userErrors[0];
      if (error) setProblem(error.message);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {asking ? (
        <Alert tone="warning">
          <p>{t('fbr.disconnectAsk', { posId })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={remove.isPending}
              onClick={() => void onDisconnect()}
            >
              {t('meta.disconnectSure')}
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {t('meta.keep')}
            </Button>
          </div>
        </Alert>
      ) : (
        <Button
          variant="danger"
          className="self-start"
          icon={<Link2Off aria-hidden className="size-5" />}
          onClick={() => setAsking(true)}
        >
          {t('fbr.disconnect')}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

/** One invoice or credit note issued while the POS was connected, and how reporting it went. */
function InvoiceRow({
  invoice,
  timezone,
  connected,
  retrying,
  onRetry,
}: {
  invoice: FiscalInvoice;
  timezone: string;
  connected: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const badge = STATUS_BADGES[invoice.status];
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-medium">
          {t(`fbr.kind.${invoice.kind}` as MessageKey)}{' '}
          <span className="num" dir="ltr">
            {invoice.usin}
          </span>
        </span>
        <Badge
          colour={badge.colour}
          icon={badge.icon}
          label={t(`fbr.status.${invoice.status}` as MessageKey)}
        />
      </span>
      <span className="flex flex-wrap gap-x-3 text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        <span>
          {t('fbr.issued', { date: formatDateTime(invoice.createdAt, timezone, locale) })}
        </span>
        {invoice.status === 'REPORTED' && invoice.fbrInvoiceNumber && (
          <span>
            {t('fbr.number')}{' '}
            <span className="num" dir="ltr">
              {invoice.fbrInvoiceNumber}
            </span>
          </span>
        )}
        {invoice.attempts > 1 && <span>{t('meta.attempts', { count: invoice.attempts })}</span>}
        <Link
          to="/$shopId/orders/$orderId"
          params={{ shopId: shop.id, orderId: invoice.orderId }}
          className="font-medium text-primary underline"
        >
          {t('meta.order')}
        </Link>
      </span>
      {invoice.error && (
        <span dir="auto" className="text-danger text-[length:var(--hatti-type-body-sm-size)]">
          {invoice.error}
        </span>
      )}
      {connected && (invoice.status === 'FAILED' || invoice.status === 'SKIPPED') && (
        <Button
          variant="secondary"
          className="self-start"
          busy={retrying}
          icon={<RotateCw aria-hidden className="size-5" />}
          onClick={onRetry}
        >
          {t('fbr.retry')}
        </Button>
      )}
    </li>
  );
}

/**
 * The latest 50 invoices and credit notes issued while the POS was connected, all of them or those
 * of one status, each refused or left unsent to send again while it is connected.
 */
function FiscalInvoices({ connected }: { connected: boolean }) {
  const { t } = useLocale();
  const timezone = useShopTimezone();
  const [status, setStatus] = useState<StatusChoice>('ALL');
  const query = useAdminQuery<FiscalInvoicesData>(['fiscalInvoices', status], FiscalInvoicesQuery, {
    status: status === 'ALL' ? null : status,
  });
  const retry = useAdminMutation<FiscalInvoiceRetryData, { id: string }>(
    FiscalInvoiceRetryMutation,
  );
  const [retrying, setRetrying] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const onRetry = async (invoice: FiscalInvoice) => {
    setNotice(null);
    setRetrying(invoice.id);
    try {
      const { fiscalInvoiceRetry } = await retry.mutateAsync({ id: invoice.id });
      const error = fiscalInvoiceRetry.userErrors[0];
      setNotice(
        error
          ? { tone: 'danger', text: `${invoice.usin}: ${error.message}` }
          : { tone: 'success', text: t('fbr.retried', { usin: invoice.usin }) },
      );
    } catch (failure) {
      setNotice({ tone: 'danger', text: errorText(failure, t) });
    } finally {
      setRetrying(null);
    }
  };

  return (
    <FormSection title={t('fbr.invoices')} hint={t('fbr.invoicesHint')}>
      <SelectField<StatusChoice>
        label={t('meta.showing')}
        value={status}
        options={STATUSES.map((each) => ({
          value: each,
          label: each === 'ALL' ? t('fbr.all') : t(`fbr.status.${each}` as MessageKey),
        }))}
        onChange={setStatus}
      />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.fiscalInvoices.length === 0 ? (
        <p className="text-secondary">{t('fbr.noInvoices')}</p>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {query.data.fiscalInvoices.map((invoice) => (
              <InvoiceRow
                key={invoice.id}
                invoice={invoice}
                timezone={timezone}
                connected={connected}
                retrying={retrying === invoice.id}
                onRetry={() => void onRetry(invoice)}
              />
            ))}
          </ul>
        </Card>
      )}
    </FormSection>
  );
}

/**
 * FBR's POS integration for Tier-1 retailers (POS-04, TAX-04, ADR-555), on the sales tax page for
 * those who open settings: the shop's POS connected, changed and disconnected, and the invoices
 * and credit notes reported, with how each went.
 */
export function FbrPosSection() {
  const { t } = useLocale();
  const shop = useShop();
  const allowed = OPENS_SETTINGS.includes(shop.role);
  const query = useAdminQuery<FbrPosData>(['fbrPos'], FbrPosQuery, undefined, {
    enabled: allowed,
  });
  if (!allowed) return null;
  const current = query.data?.fbrPos ?? null;
  return (
    <>
      <FormSection title={t('fbr.title')} hint={t('fbr.hint')}>
        {query.isPending ? (
          <Loading label={t('state.loading')} />
        ) : query.isError ? (
          <ErrorState
            message={errorText(query.error, t)}
            action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
          />
        ) : (
          <>
            {current ? (
              <Connected pos={current} />
            ) : (
              <p className="font-medium">{t('fbr.notConnected')}</p>
            )}
            <FbrForm current={current} />
            {current && <Disconnect posId={current.posId} />}
          </>
        )}
      </FormSection>
      {query.isSuccess && <FiscalInvoices connected={current !== null} />}
    </>
  );
}
