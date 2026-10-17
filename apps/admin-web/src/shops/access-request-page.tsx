import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Handshake } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { StaffMemberRole } from '../api/types';
import { AuthLayout } from '../auth/auth-layout';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { SelectField } from '../settings/settings-form';
import { roleLabel } from '../settings/settings-page';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';

/** A request for access as its asker sees it (ADR-488). */
export interface MyAccessRequest {
  id: string;
  shop: { name: string };
  role: string;
  accessDays: number;
  message: string | null;
  status: 'pending' | 'approved' | 'declined' | 'expired';
  createdAt: string;
  expiresAt: string;
}

const ROLES: readonly StaffMemberRole[] = [
  'MARKETER',
  'MANAGER',
  'CONFIRMATION_AGENT',
  'PACKER',
  'ACCOUNTANT',
];
const DAYS = ['7', '30', '90'] as const;
const KEY = ['accessRequests'] as const;

/** A shop's address as typed: its handle, or its Hatti link, which starts with it. */
export function handleOf(typed: string): string {
  const host = typed
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split(/[/?#]/)[0]!;
  return host.split('.')[0] ?? '';
}

/**
 * Asking a shop for access (ADM-07, ADR-488): an agency or a freelancer, signed in to their own
 * account, names the shop by its address, the role and the days they need and who they are; its
 * owner approves or declines it within 7 days. Their requests of the last 30 days, below.
 */
export function AccessRequestPage() {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const mine = useQuery({
    queryKey: KEY,
    queryFn: () => store.auth<{ requests: MyAccessRequest[] }>('/auth/access-requests'),
  });
  const [shop, setShop] = useState('');
  const [role, setRole] = useState<StaffMemberRole>('MARKETER');
  const [days, setDays] = useState<(typeof DAYS)[number]>('30');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setAsked(null);
    try {
      const { request } = await store.auth<{ request: MyAccessRequest }>('/auth/access-requests', {
        body: {
          shop: handleOf(shop),
          role: role.toLowerCase(),
          accessDays: Number(days),
          message: message.trim() || null,
        },
      });
      setAsked(request.shop.name);
      setShop('');
      setMessage('');
      await queryClient.invalidateQueries({ queryKey: KEY });
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const requests = mine.data?.requests ?? [];
  return (
    <AuthLayout title={t('askAccess.title')}>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <p className="text-secondary">{t('askAccess.body')}</p>
        <TextField
          label={t('askAccess.shop')}
          hint={t('askAccess.shopHint')}
          ltr
          value={shop}
          onChange={(event) => setShop(event.target.value)}
          required
        />
        <SelectField<StaffMemberRole>
          label={t('staff.role')}
          value={role}
          options={ROLES.map((value) => ({ value, label: t(roleLabel(value)) }))}
          onChange={setRole}
        />
        <SelectField<(typeof DAYS)[number]>
          label={t('staff.access')}
          value={days}
          options={DAYS.map((value) => ({
            value,
            label: t('staff.accessFor', { days: Number(value) }),
          }))}
          onChange={setDays}
        />
        <TextField
          label={t('askAccess.message')}
          hint={t('askAccess.messageHint')}
          maxLength={300}
          dir="auto"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        {asked && <Alert tone="success">{t('askAccess.asked', { shop: asked })}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Button type="submit" busy={busy} icon={<Handshake aria-hidden className="size-5" />}>
          {t('askAccess.submit')}
        </Button>
      </form>
      {requests.length > 0 && (
        <section aria-labelledby="my-access-requests" className="mt-6 flex flex-col gap-2">
          <h2 id="my-access-requests" className="font-semibold">
            {t('askAccess.mine')}
          </h2>
          <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
            {requests.map((request) => (
              <li key={request.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium" dir="auto">
                    {request.shop.name}
                  </span>
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {t(roleLabel(request.role.toUpperCase() as StaffMemberRole))} ·{' '}
                    {t('staff.accessFor', { days: request.accessDays })} ·{' '}
                    {formatDate(request.createdAt, 'Asia/Karachi', locale)}
                  </span>
                </span>
                <span className="font-medium">
                  {t(`askAccess.status.${request.status}` as MessageKey)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Link to="/shops" className="mt-4 inline-flex min-h-10 items-center text-secondary">
        {t('askAccess.back')}
      </Link>
    </AuthLayout>
  );
}
