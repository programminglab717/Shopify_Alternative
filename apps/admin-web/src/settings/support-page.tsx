import { LifeBuoy, ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  SupportAccessEndMutation,
  SupportAccessGrantMutation,
  SupportAccessQuery,
} from '../api/operations';
import type {
  SupportAccessData,
  SupportAccessEndData,
  SupportAccessGrantData,
  SupportGrant,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { SelectField } from './settings-form';
import { BackToSettings } from './settings-page';

/** How long support may look, as the owner chooses it: 15 minutes to a day. */
const SPANS = ['15', '60', '240', '1440'] as const;
type Span = (typeof SPANS)[number];

/** The owner lets Hatti's support look, for a while and for a reason, once they confirm who they are. */
function GrantForm() {
  const { t } = useLocale();
  const grant = useAdminMutation<SupportAccessGrantData, { minutes: number; note: string | null }>(
    SupportAccessGrantMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const [span, setSpan] = useState<Span>('60');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    void run(
      async () => {
        const { supportAccessGrant } = await grant.mutateAsync({
          minutes: Number(span),
          note: note.trim() || null,
        });
        const error = supportAccessGrant.userErrors[0];
        if (error) setProblem(problemText(error, t));
        else setNote('');
      },
      (failure) => setProblem(errorText(failure, t)),
    );
  };

  const form = (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <SelectField<Span>
        label={t('support.span')}
        value={span}
        options={SPANS.map((minutes) => ({
          value: minutes,
          label: t(`support.span.${minutes}` as MessageKey),
        }))}
        onChange={setSpan}
      />
      <TextField
        label={t('support.note')}
        hint={t('support.noteHint')}
        dir="auto"
        maxLength={200}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={grant.isPending}
        icon={<ShieldCheck aria-hidden className="size-5" />}
      >
        {t('support.grant')}
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

/** One time support was let in: by whom, why, and how long it lasted. */
function GrantRow({ grant, timezone }: { grant: SupportGrant; timezone: string }) {
  const { t, locale } = useLocale();
  const when = (iso: string) => formatDateTime(iso, timezone, locale);
  return (
    <li className="flex flex-col gap-0.5 px-4 py-3">
      <span className="flex flex-wrap justify-between gap-x-3">
        <span className="font-medium">
          {t('support.by', { name: grant.grantedBy, date: when(grant.createdAt) })}
        </span>
        {grant.open && <span className="font-medium text-success">{t('support.openNow')}</span>}
      </span>
      {grant.note && (
        <span dir="auto" className="text-secondary">
          {grant.note}
        </span>
      )}
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {grant.open
          ? t('support.until', { date: when(grant.expiresAt) })
          : grant.endedAt && grant.endedBy
            ? t('support.endedBy', { name: grant.endedBy, date: when(grant.endedAt) })
            : t('support.ran', { date: when(grant.endedAt ?? grant.expiresAt) })}
      </span>
    </li>
  );
}

/**
 * Support access (ADM-08): whether Hatti's support may look at the shop now, and until when; the
 * owner lets it in for a while and a reason, having signed in lately; the owner or a manager ends
 * it; and each time it was let in. Support reads, numbers masked, changes nothing, and every
 * request it makes is on the activity log.
 */
export function SupportAccessPage() {
  const { t, locale } = useLocale();
  const { role } = useShop();
  const timezone = useShopTimezone();
  const query = useAdminQuery<SupportAccessData>(['supportAccess'], SupportAccessQuery);
  const end = useAdminMutation<SupportAccessEndData, Record<string, never>>(
    SupportAccessEndMutation,
  );
  const [problem, setProblem] = useState<string | null>(null);

  const onEnd = async () => {
    setProblem(null);
    try {
      const { supportAccessEnd } = await end.mutateAsync({});
      const error = supportAccessEnd.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const body = () => {
    if (query.isPending) return <Loading label={t('state.loading')} />;
    if (query.isError) {
      return (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      );
    }
    const now = query.data.supportAccess;
    const past = query.data.supportAccessGrants;
    return (
      <>
        <Card className="flex flex-col gap-3 p-4">
          <p className="text-secondary">{t('support.hint')}</p>
          {now?.open ? (
            <>
              <Alert tone="warning">
                {t('support.open', {
                  date: formatDateTime(now.expiresAt, timezone, locale),
                  name: now.grantedBy,
                })}
                {now.note && ` “${now.note}”`}
              </Alert>
              <Button
                variant="danger"
                className="self-start"
                busy={end.isPending}
                icon={<ShieldOff aria-hidden className="size-5" />}
                onClick={() => void onEnd()}
              >
                {t('support.end')}
              </Button>
            </>
          ) : (
            <>
              <p className="font-medium">{t('support.closed')}</p>
              {role === 'owner' ? (
                <GrantForm />
              ) : (
                <p className="text-secondary">{t('support.ownerOnly')}</p>
              )}
            </>
          )}
          {problem && <Alert tone="danger">{problem}</Alert>}
        </Card>
        {past.length > 0 && (
          <section aria-labelledby="support-history" className="flex flex-col gap-2">
            <h2 id="support-history" className="font-semibold">
              {t('support.history')}
            </h2>
            <Card>
              <ul className="divide-y divide-line">
                {past.map((grant) => (
                  <GrantRow key={grant.id} grant={grant} timezone={timezone} />
                ))}
              </ul>
            </Card>
          </section>
        )}
      </>
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <LifeBuoy aria-hidden className="size-7 text-secondary" />
        {t('support.title')}
      </h1>
      {body()}
    </div>
  );
}
