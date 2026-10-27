import { BellRing, CircleCheck, Send } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { PushCampaignSendMutation, ShopperPushesQuery } from '../api/operations';
import type { PushCampaignSendData, PushCampaignValue, ShopperPushesData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { BackToMarketing } from './templates-page';

/** What a push may say, as the core takes it (ADR-834). */
const LIMITS = { title: 60, body: 180 } as const;

/** A push's form: its title, its words and the shop's page it opens. */
function SendForm({ subscribers }: { subscribers: number }) {
  const { t } = useLocale();
  const send = useAdminMutation<PushCampaignSendData, { input: object }>(PushCampaignSendMutation);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [path, setPath] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSent(false);
    try {
      const { pushCampaignSend } = await send.mutateAsync({
        input: { title: title.trim(), body: body.trim(), path: path.trim() || null },
      });
      const error = pushCampaignSend.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return;
      }
      setTitle('');
      setBody('');
      setPath('');
      setSent(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <TextField
          label={t('pushes.titleField')}
          value={title}
          maxLength={LIMITS.title}
          dir="auto"
          required
          onChange={(event) => setTitle(event.target.value)}
        />
        <TextField
          label={t('pushes.body')}
          value={body}
          maxLength={LIMITS.body}
          dir="auto"
          required
          onChange={(event) => setBody(event.target.value)}
        />
        <TextField
          label={t('pushes.path')}
          hint={t('pushes.pathHint')}
          value={path}
          ltr
          placeholder="/collections/eid"
          onChange={(event) => setPath(event.target.value)}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {sent && <Alert tone="success">{t('pushes.sent')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={send.isPending}
          disabled={subscribers === 0}
          icon={<Send aria-hidden className="size-5" />}
        >
          {t('pushes.send')}
        </Button>
      </form>
    </Card>
  );
}

/** A campaign: what it said, when, and how far it went. */
function CampaignRow({ campaign }: { campaign: PushCampaignValue }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const done = campaign.status === 'SENT';
  return (
    <li className="flex flex-col gap-1 border-t border-line px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium" dir="auto">
          {campaign.title}
        </span>
        {done ? (
          <Badge colour="delivered" icon={CircleCheck} label={t('pushes.status.SENT')} />
        ) : (
          <Badge colour="inTransit" icon={Send} label={t('pushes.status.SENDING')} />
        )}
      </div>
      <span className="text-secondary" dir="auto">
        {campaign.body}
      </span>
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        <span className="num">{formatDateTime(campaign.createdAt, timezone, locale)}</span>
        {' · '}
        <span dir="ltr">{campaign.path}</span>
        {' · '}
        {t('pushes.reached', {
          sent: formatCount(campaign.sent),
          gone: formatCount(campaign.gone),
        })}
      </span>
    </li>
  );
}

/**
 * Push notifications (OS-14, ADR-835): how many shoppers' browsers have the shop's notifications
 * on, a push sent to all of them, its title, its words and the page it opens, and the pushes sent
 * before, with how far each went. The worker sends them in marketing hours.
 */
export function PushPage() {
  const { t } = useLocale();
  const query = useAdminQuery<ShopperPushesData>(['shopperPushes'], ShopperPushesQuery);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToMarketing />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <BellRing aria-hidden className="size-7 text-secondary" />
        {t('pushes.title')}
      </h1>
      <p className="text-secondary">{t('pushes.intro')}</p>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : !query.data.shopperPushes.available ? (
        <Alert tone="info">{t('pushes.unavailable')}</Alert>
      ) : (
        <>
          <p className="font-medium">
            {t('pushes.subscribers', {
              count: formatCount(query.data.shopperPushes.subscribers),
            })}
          </p>
          <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('pushes.rules', { perDay: query.data.shopperPushes.perDay })}
          </p>
          <SendForm subscribers={query.data.shopperPushes.subscribers} />
          <h2 className="font-semibold">{t('pushes.list')}</h2>
          {query.data.shopperPushes.campaigns.length === 0 ? (
            <EmptyState title={t('pushes.none')} />
          ) : (
            <Card>
              <ul aria-label={t('pushes.list')}>
                {query.data.shopperPushes.campaigns.map((campaign) => (
                  <CampaignRow key={campaign.id} campaign={campaign} />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
