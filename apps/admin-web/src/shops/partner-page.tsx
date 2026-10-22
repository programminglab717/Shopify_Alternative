import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Store } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api/client';
import type { StaffMemberRole } from '../api/types';
import { AuthLayout } from '../auth/auth-layout';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { roleLabel } from '../settings/settings-page';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { TermsAgreement, useTermsAgreement } from './terms-agreement';

/** A partner as they see themselves (ADR-504). */
export interface Partner {
  businessName: string;
  website: string | null;
  referralCode: string;
  /** The bank account Hatti pays their share into (ADR-505). */
  payout: { title: string; iban: string } | null;
  joinedAt: string;
}

/** What a partner earned, in paisa as strings (ADR-505). */
export interface PartnerEarnings {
  earned: string;
  paidOut: string;
  owed: string;
  entries: {
    shopName: string;
    invoiceNumber: string;
    plan: string;
    invoiceAmount: string;
    sharePercent: number;
    amount: string;
    earnedAt: string;
    paidOutAt: string | null;
    payoutReference: string | null;
  }[];
}

/** A store on a partner's dashboard (ADR-504). */
export interface PartnerStore {
  id: string;
  name: string;
  handle: string;
  status: 'active' | 'suspended' | 'closed';
  kind: 'development' | 'transferred' | 'referred' | 'client';
  role: string | null;
  accessEndsAt: string | null;
  since: string;
  transferredAt: string | null;
}

const KEY = ['partner'] as const;

/**
 * Hatti's partner programme (PRT-01, ADR-504): an agency or a freelancer joins from their own
 * account, opens development stores that stay closed to shoppers while they build them, and sees
 * every store they built, brought or work in. A store is handed to its client as an owner hands
 * over any shop: from Settings → Staff, once the client is a manager there.
 */
export function PartnerPage() {
  const { t } = useLocale();
  const store = useSessionStore();
  const dashboard = useQuery({
    queryKey: KEY,
    queryFn: () =>
      store.auth<{
        partner: Partner | null;
        stores: PartnerStore[];
        earnings: PartnerEarnings | null;
      }>('/auth/partner'),
  });
  const partner = dashboard.data?.partner ?? null;
  return (
    <AuthLayout title={t('partner.title')}>
      {dashboard.isPending ? null : partner ? (
        <>
          <Dashboard partner={partner} stores={dashboard.data?.stores ?? []} />
          {dashboard.data?.earnings && (
            <Earnings partner={partner} earnings={dashboard.data.earnings} />
          )}
        </>
      ) : (
        <Join />
      )}
      <Link to="/shops" className="mt-4 inline-flex min-h-10 items-center text-secondary">
        {t('askAccess.back')}
      </Link>
    </AuthLayout>
  );
}

function Join() {
  const { t } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await store.auth('/auth/partner', {
        body: { businessName: name.trim(), website: website.trim() || null },
      });
      await queryClient.invalidateQueries({ queryKey: KEY });
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <p className="text-secondary">{t('partner.body')}</p>
      <TextField
        label={t('partner.business')}
        dir="auto"
        maxLength={120}
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />
      <TextField
        label={t('partner.website')}
        hint={t('partner.websiteHint')}
        ltr
        type="url"
        value={website}
        onChange={(event) => setWebsite(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button type="submit" busy={busy}>
        {t('partner.join')}
      </Button>
    </form>
  );
}

function Dashboard({ partner, stores }: { partner: Partner; stores: PartnerStore[] }) {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  // The partner agrees to Hatti's terms as the store's owner while they build it (ADR-737).
  const agreement = useTermsAgreement();

  const onOpen = async (event: FormEvent) => {
    event.preventDefault();
    if (!agreement.agreed) return;
    setBusy(true);
    setProblem(null);
    setOpened(null);
    try {
      const { shop } = await store.auth<{ shop: { name: string } }>('/auth/partner/stores', {
        body: { name: name.trim(), agreed: agreement.agreed },
      });
      setOpened(shop.name);
      setName('');
      await queryClient.invalidateQueries({ queryKey: KEY });
    } catch (failure) {
      setProblem(errorText(failure, t));
      if (failure instanceof ApiError && failure.code === 'TERMS_CHANGED') {
        await agreement.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-secondary">
        <span className="font-medium text-primary" dir="auto">
          {partner.businessName}
        </span>{' '}
        · {t('partner.code', { code: partner.referralCode })}
      </p>
      <form onSubmit={(event) => void onOpen(event)} className="flex flex-col gap-3">
        <TextField
          label={t('partner.storeName')}
          hint={t('partner.storeHint')}
          dir="auto"
          maxLength={255}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <TermsAgreement agreement={agreement} />
        {opened && <Alert tone="success">{t('partner.opened', { shop: opened })}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Button type="submit" busy={busy} icon={<Store aria-hidden className="size-5" />}>
          {t('partner.open')}
        </Button>
      </form>
      <section aria-labelledby="partner-stores" className="flex flex-col gap-2">
        <h2 id="partner-stores" className="font-semibold">
          {t('partner.stores')}
        </h2>
        {stores.length === 0 ? (
          <p className="text-secondary">{t('partner.none')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
            {stores.map((each) => (
              <li key={each.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  {each.role ? (
                    <Link
                      to="/$shopId"
                      params={{ shopId: each.id }}
                      className="font-medium underline"
                      dir="auto"
                    >
                      {each.name}
                    </Link>
                  ) : (
                    <span className="font-medium" dir="auto">
                      {each.name}
                    </span>
                  )}
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    <bdi dir="ltr">{each.handle}</bdi>
                    {each.role && ` · ${t(roleLabel(each.role.toUpperCase() as StaffMemberRole))}`}
                    {' · '}
                    {each.transferredAt
                      ? t('partner.handedOver', {
                          date: formatDate(each.transferredAt, 'Asia/Karachi', locale),
                        })
                      : formatDate(each.since, 'Asia/Karachi', locale)}
                  </span>
                </span>
                <span className="font-medium">{t(`partner.kind.${each.kind}` as MessageKey)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** "Rs 599.80": paisa, as the API gives a partner's sums, in rupees. */
const rupees = (paisa: string) => {
  const value = BigInt(paisa);
  return formatMoney(`${value / 100n}.${String(value % 100n).padStart(2, '0')}`);
};

/**
 * What the partner earned of the stores they brought (PRT-02, ADR-505): 20% of each plan invoice
 * they pay, the link that brings them, and the bank account Hatti pays it into.
 */
function Earnings({ partner, earnings }: { partner: Partner; earnings: PartnerEarnings }) {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(partner.payout?.title ?? '');
  const [iban, setIban] = useState(partner.payout?.iban ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const link = `${window.location.origin}/sign-up?ref=${partner.referralCode}`;

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await store.auth('/auth/partner', {
        body: {
          businessName: partner.businessName,
          website: partner.website,
          payoutTitle: title.trim() || null,
          payoutIban: iban.trim() || null,
        },
      });
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: KEY });
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="partner-earnings" className="mt-6 flex flex-col gap-3">
      <h2 id="partner-earnings" className="font-semibold">
        {t('partner.earnings')}
      </h2>
      <p className="text-secondary">{t('partner.earningsBody')}</p>
      <p className="text-secondary">
        {t('partner.link')}{' '}
        <bdi dir="ltr" className="break-all font-medium text-primary">
          {link}
        </bdi>
      </p>
      <dl className="grid grid-cols-3 gap-2 rounded-control border border-line p-3">
        {(
          [
            ['partner.earned', earnings.earned],
            ['partner.paidOut', earnings.paidOut],
            ['partner.owed', earnings.owed],
          ] as const
        ).map(([label, amount]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t(label)}
            </dt>
            <dd className="font-semibold">{rupees(amount)}</dd>
          </div>
        ))}
      </dl>
      {earnings.entries.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
          {earnings.entries.map((entry) => (
            <li key={entry.invoiceNumber} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium" dir="auto">
                  {entry.shopName}
                </span>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t('partner.share', {
                    percent: entry.sharePercent,
                    amount: rupees(entry.invoiceAmount),
                  })}{' '}
                  · {formatDate(entry.earnedAt, 'Asia/Karachi', locale)}
                </span>
              </span>
              <span className="flex flex-col items-end">
                <span className="font-medium">{rupees(entry.amount)}</span>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {entry.paidOutAt ? t('partner.paid') : t('partner.toPay')}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        <TextField
          label={t('partner.payoutTitle')}
          dir="auto"
          maxLength={120}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <TextField
          label={t('partner.payoutIban')}
          hint={t('partner.payoutIbanHint')}
          ltr
          maxLength={40}
          value={iban}
          onChange={(event) => setIban(event.target.value)}
        />
        {saved && <Alert tone="success">{t('partner.payoutSaved')}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Button type="submit" variant="secondary" busy={busy}>
          {t('partner.payoutSave')}
        </Button>
      </form>
    </section>
  );
}
