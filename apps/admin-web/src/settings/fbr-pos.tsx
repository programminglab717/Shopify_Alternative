import { Link } from '@tanstack/react-router';
import type { OrderStage as BadgeColour } from '@hatti/tokens';
import type { LucideIcon } from 'lucide-react';
import { CircleCheck, CircleOff, CircleX, Clock, Link2Off, RotateCw, Save } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
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
  FbrSystem,
  FiscalInvoice,
  FiscalInvoiceRetryData,
  FiscalInvoicesData,
  FiscalInvoiceStatus,
  TaxSettings,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { permits } from '../auth/permissions';
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
import { SETS_SETTINGS } from './settings-page';

const SYSTEMS: readonly FbrSystem[] = ['POS', 'DIGITAL_INVOICING'];
const ENVIRONMENTS: readonly FbrEnvironment[] = ['SANDBOX', 'PRODUCTION'];

/** What the form sends, each of which FBR's userErrors may name. */
const FIELDS = ['system', 'posId', 'accessToken', 'environment', 'pctCode'] as const;
type Field = (typeof FIELDS)[number];

const LABELS: Partial<Record<string, MessageKey>> = {
  system: 'fbr.system',
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
 * How a shop not yet connected most likely reports, by its tax profile: through a POS if it is a
 * Tier-1 retailer, else through digital invoicing if it is registered for sales tax.
 */
function likelySystem(settings: TaxSettings): FbrSystem {
  if (settings.tier1) return 'POS';
  return settings.strn ? 'DIGITAL_INVOICING' : 'POS';
}

/**
 * One of a few choices, each with a line saying what it means, its labels the legend's key
 * followed by the choice's: "fbr.system.POS" and "fbr.system.POS.hint".
 */
function Choices<T extends string>({
  legend,
  choices,
  value,
  onChange,
  error,
  children,
}: {
  legend: MessageKey;
  choices: readonly T[];
  value: T;
  onChange: (value: T) => void;
  error?: string;
  children?: ReactNode;
}) {
  const { t } = useLocale();
  const name = useId();
  const errorId = useId();
  return (
    <fieldset className="flex flex-col gap-1" aria-describedby={error ? errorId : undefined}>
      <legend className="mb-1 font-medium">{t(legend)}</legend>
      {choices.map((each) => (
        <label key={each} className="flex min-h-10 items-start gap-2 py-1">
          <input
            type="radio"
            name={name}
            checked={value === each}
            onChange={() => onChange(each)}
            className="mt-1 size-5 shrink-0 accent-[var(--hatti-color-primary)]"
          />
          <span className="flex flex-col">
            <span>{t(`${legend}.${each}` as MessageKey)}</span>
            <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t(`${legend}.${each}.hint` as MessageKey)}
            </span>
          </span>
        </label>
      ))}
      {error && (
        <p id={errorId} className="text-danger text-[length:var(--hatti-type-body-sm-size)]">
          {error}
        </p>
      )}
      {children}
    </fieldset>
  );
}

/**
 * Connecting the shop to FBR, or changing what it gave: how it reports, through its POS or FBR's
 * digital invoicing; the POS ID, for a POS; the token FBR gave, sealed and never shown again;
 * FBR's sandbox or production; and the PCT code its items are reported under. Only what changed
 * is sent, once the member confirms who they are; a problem FBR's fields name shows under that
 * field. Switching how a connected shop reports needs the other's token, and a POS ID for a POS.
 */
function FbrForm({ current, settings }: { current: FbrPos | null; settings: TaxSettings }) {
  const { t } = useLocale();
  const update = useAdminMutation<FbrPosUpdateData, { input: Record<string, unknown> }>(
    FbrPosUpdateMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const keptPosId = current && current.posId !== null ? String(current.posId) : '';
  const [system, setSystem] = useState<FbrSystem>(current?.system ?? likelySystem(settings));
  const [posId, setPosId] = useState(keptPosId);
  const [accessToken, setAccessToken] = useState('');
  const [environment, setEnvironment] = useState<FbrEnvironment>(current?.environment ?? 'SANDBOX');
  const [pctCode, setPctCode] = useState(current ? pctText(current.pctCode) : '');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const pos = system === 'POS';
  const switching = current !== null && system !== current.system;
  // Connecting, or switching, needs a token for the way chosen, and a POS ID for a POS.
  const fresh = !current || switching;
  const posIdChanged = pos && posId.trim() !== keptPosId;
  const changes: Record<string, unknown> = {
    ...(fresh && { system }),
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
    const missing: Partial<Record<Field, string>> = {
      ...(pos &&
        (posIdChanged || fresh) &&
        !/^\d{1,10}$/.test(posId.trim()) && {
          posId: t('fbr.badPosId'),
        }),
      ...(fresh && !accessToken.trim() && { accessToken: t('fbr.tokenNeeded') }),
    };
    setErrors(missing);
    if (Object.keys(missing).length > 0) return;
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
        setSystem(kept.system);
        setPosId(kept.posId !== null ? String(kept.posId) : '');
        setAccessToken('');
        setEnvironment(kept.environment);
        setPctCode(pctText(kept.pctCode));
        setSaved(true);
      },
      (failure) => setProblems([errorText(failure, t)]),
    );
  };

  const tokenLabel: MessageKey = pos
    ? fresh
      ? 'fbr.accessToken'
      : 'fbr.newAccessToken'
    : fresh
      ? 'fbr.securityToken'
      : 'fbr.newSecurityToken';
  const form = (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Choices
        legend="fbr.system"
        choices={SYSTEMS}
        value={system}
        onChange={setSystem}
        error={errors.system}
      >
        {switching && <Alert tone="warning">{t('fbr.switchNote')}</Alert>}
        {!pos && (
          <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('fbr.diDetails')}
          </p>
        )}
      </Choices>
      {pos && (
        <TextField
          label={t('fbr.posId')}
          hint={t('fbr.posIdHint')}
          inputMode="numeric"
          autoComplete="off"
          ltr
          className="max-w-xs"
          required={fresh}
          error={errors.posId}
          value={posId}
          onChange={(event) => setPosId(event.target.value)}
        />
      )}
      <TextField
        label={t(tokenLabel)}
        hint={
          current && !fresh
            ? t('fbr.accessTokenKept', { hint: current.accessTokenHint })
            : t(pos ? 'fbr.accessTokenHint' : 'fbr.securityTokenHint')
        }
        type="password"
        autoComplete="off"
        ltr
        required={fresh}
        error={errors.accessToken}
        value={accessToken}
        onChange={(event) => setAccessToken(event.target.value)}
      />
      <Choices
        legend="fbr.environment"
        choices={ENVIRONMENTS}
        value={environment}
        onChange={setEnvironment}
        error={errors.environment}
      />
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

/**
 * How the shop reports to FBR and what it gave: the POS ID, for a POS, and its token as its last
 * four characters alone.
 */
function Connected({ pos }: { pos: FbrPos }) {
  const { t } = useLocale();
  const viaPos = pos.system === 'POS';
  const rows: { label: MessageKey; value: string; ltr: boolean }[] = [
    { label: 'fbr.system', value: t(`fbr.systemName.${pos.system}`), ltr: false },
    ...(pos.posId !== null
      ? [{ label: 'fbr.posId' as const, value: String(pos.posId), ltr: true }]
      : []),
    {
      label: viaPos ? 'fbr.accessToken' : 'fbr.securityToken',
      value: `•••• ${pos.accessTokenHint}`,
      ltr: true,
    },
    {
      label: 'fbr.environment',
      value: t(`fbr.environment.${pos.environment}` as MessageKey),
      ltr: false,
    },
    { label: 'fbr.pctCode', value: pctText(pos.pctCode), ltr: true },
  ];
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="success">
        {t(viaPos ? 'fbr.connected' : 'fbr.connected.DIGITAL_INVOICING')}
      </Alert>
      {pos.environment === 'SANDBOX' && (
        <Alert tone="warning">
          {t(viaPos ? 'fbr.sandboxNote' : 'fbr.sandboxNote.DIGITAL_INVOICING')}
        </Alert>
      )}
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

/** Disconnecting FBR, once asked whether they mean it, the question naming how the shop reports. */
function Disconnect({ pos }: { pos: FbrPos }) {
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
          <p>
            {pos.system === 'POS' && pos.posId !== null
              ? t('fbr.disconnectAsk', { posId: pos.posId })
              : t('fbr.disconnectAsk.DIGITAL_INVOICING')}
          </p>
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

/**
 * One invoice or credit note issued while FBR was connected, and how reporting it went: how it is
 * reported too, when the list has some of each.
 */
function InvoiceRow({
  invoice,
  timezone,
  showSystem,
  connected,
  retrying,
  onRetry,
}: {
  invoice: FiscalInvoice;
  timezone: string;
  showSystem: boolean;
  connected: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const badge = STATUS_BADGES[invoice.status];
  // FBR's digital invoicing takes no credit notes: they go in the sales tax return instead.
  const sendable =
    connected && !(invoice.system === 'DIGITAL_INVOICING' && invoice.kind === 'CREDIT_NOTE');
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
        {showSystem && <span>{t(`fbr.systemName.${invoice.system}`)}</span>}
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
      {sendable && (invoice.status === 'FAILED' || invoice.status === 'SKIPPED') && (
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
 * The latest 50 invoices and credit notes issued while FBR was connected, all of them or those of
 * one status, each refused or left unsent to send again while the way it was kept for is
 * connected.
 */
function FiscalInvoices({ connected }: { connected: FbrSystem | null }) {
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

  // How each was reported shows only when the list has some of each.
  const listed = query.data?.fiscalInvoices ?? [];
  const mixed = listed.some((each) => each.system !== listed[0]?.system);

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
                showSystem={mixed}
                connected={invoice.system === connected}
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
 * Reporting to FBR (POS-04, TAX-04, ADR-555, ADR-562, ADR-563), on the sales tax page for those
 * who open settings: through FBR's POS integration, for Tier-1 retailers, or its digital
 * invoicing, for sellers registered for sales tax, the shop's tax settings suggesting which;
 * connected, changed, switched and disconnected; and the invoices and credit notes reported, with
 * how each went.
 */
export function FbrPosSection({ settings }: { settings: TaxSettings }) {
  const { t } = useLocale();
  const shop = useShop();
  const allowed = permits(shop, SETS_SETTINGS);
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
            <FbrForm current={current} settings={settings} />
            {current && <Disconnect pos={current} />}
          </>
        )}
      </FormSection>
      {query.isSuccess && <FiscalInvoices connected={current?.system ?? null} />}
    </>
  );
}
