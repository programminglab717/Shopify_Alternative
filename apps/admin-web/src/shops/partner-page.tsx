import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Store } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { StaffMemberRole } from '../api/types';
import { AuthLayout } from '../auth/auth-layout';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { roleLabel } from '../settings/settings-page';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';

/** A partner as they see themselves (ADR-504). */
export interface Partner {
  businessName: string;
  website: string | null;
  referralCode: string;
  joinedAt: string;
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
    queryFn: () => store.auth<{ partner: Partner | null; stores: PartnerStore[] }>('/auth/partner'),
  });
  const partner = dashboard.data?.partner ?? null;
  return (
    <AuthLayout title={t('partner.title')}>
      {dashboard.isPending ? null : partner ? (
        <Dashboard partner={partner} stores={dashboard.data?.stores ?? []} />
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

  const onOpen = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setOpened(null);
    try {
      const { shop } = await store.auth<{ shop: { name: string } }>('/auth/partner/stores', {
        body: { name: name.trim() },
      });
      setOpened(shop.name);
      setName('');
      await queryClient.invalidateQueries({ queryKey: KEY });
    } catch (failure) {
      setProblem(errorText(failure, t));
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
