import { Copy, Globe, Plus, RefreshCw, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  DomainCreateMutation,
  DomainDeleteMutation,
  DomainUpdateMutation,
  DomainVerifyMutation,
  ShopDomainsQuery,
} from '../api/operations';
import type { ShopDomain, ShopDomainsData, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { BackToSettings } from './settings-page';

type Payload = { domain: ShopDomain | null; userErrors: UserError[] };

/** Runs a change of a domain and says what went wrong, the core's words or the network's. */
function useChange() {
  const { t } = useLocale();
  const [problem, setProblem] = useState<string | null>(null);
  const change = async (run: () => Promise<{ userErrors: UserError[] }>): Promise<boolean> => {
    setProblem(null);
    try {
      const error = (await run()).userErrors[0];
      if (error) setProblem(problemText(error, t));
      return !error;
    } catch (failure) {
      setProblem(errorText(failure, t));
      return false;
    }
  };
  return { problem, change };
}

/** Where to point a domain not yet pointed at Hatti: a CNAME record, copied in a tap. */
function PointIt({ domain }: { domain: ShopDomain }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-control bg-canvas p-3">
      <p>{t('domains.pointIt', { host: domain.host })}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-secondary">{t('domains.recordType')}</dt>
        <dd className="num">CNAME</dd>
        <dt className="text-secondary">{t('domains.recordName')}</dt>
        <dd className="num" dir="ltr">
          {domain.host}
        </dd>
        <dt className="text-secondary">{t('domains.recordValue')}</dt>
        <dd className="num break-all" dir="ltr">
          {domain.dnsTarget}
        </dd>
      </dl>
      <Button
        variant="secondary"
        className="self-start"
        icon={<Copy aria-hidden className="size-5" />}
        onClick={() =>
          void navigator.clipboard?.writeText(domain.dnsTarget).then(() => setCopied(true))
        }
      >
        {copied ? t('domains.copied') : t('domains.copyTarget')}
      </Button>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('domains.pointItHint')}
      </p>
    </div>
  );
}

/** One domain: whether it points at Hatti, made primary or not, checked again, or let go. */
function DomainRow({ domain }: { domain: ShopDomain }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const verify = useAdminMutation<{ domainVerify: Payload }, { id: string }>(DomainVerifyMutation);
  const update = useAdminMutation<
    { domainUpdate: Payload },
    { id: string; domain: { isPrimary: boolean } }
  >(DomainUpdateMutation);
  const remove = useAdminMutation<{ domainDelete: { userErrors: UserError[] } }, { id: string }>(
    DomainDeleteMutation,
  );
  const { problem, change } = useChange();
  const [asking, setAsking] = useState(false);

  const status = !domain.isVerified
    ? t('domains.notPointed')
    : domain.unpointedSince
      ? t('domains.pointedElsewhere', {
          since: formatRelative(domain.unpointedSince, timezone, locale),
        })
      : t('domains.connected');

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <a
          href={domain.url}
          target="_blank"
          rel="noreferrer"
          className="num font-semibold hover:underline"
          dir="ltr"
        >
          {domain.host}
        </a>
        {domain.isPrimary && (
          <span className="rounded-full bg-canvas px-2 text-[length:var(--hatti-type-body-sm-size)] font-medium">
            {t('domains.primary')}
          </span>
        )}
        <span
          className={domain.isVerified && !domain.unpointedSince ? 'text-success' : 'text-warning'}
        >
          {status}
        </span>
      </div>
      {(!domain.isVerified || domain.unpointedSince) && <PointIt domain={domain} />}
      {asking ? (
        <Alert tone="warning">
          <p>{t('domains.deleteAsk', { host: domain.host })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={remove.isPending}
              onClick={() =>
                void change(
                  async () => (await remove.mutateAsync({ id: domain.id })).domainDelete,
                ).then(() => setAsking(false))
              }
            >
              {t('domains.deleteSure')}
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {t('domains.keep')}
            </Button>
          </div>
        </Alert>
      ) : (
        <div className="flex flex-wrap gap-2">
          {(!domain.isVerified || domain.unpointedSince) && (
            <Button
              variant="secondary"
              busy={verify.isPending}
              icon={<RefreshCw aria-hidden className="size-5" />}
              aria-label={t('domains.checkOf', { host: domain.host })}
              onClick={() =>
                void change(async () => (await verify.mutateAsync({ id: domain.id })).domainVerify)
              }
            >
              {t('domains.check')}
            </Button>
          )}
          {domain.isVerified && !domain.unpointedSince && (
            <Button
              variant="secondary"
              busy={update.isPending}
              icon={<Star aria-hidden className="size-5" />}
              aria-label={t(domain.isPrimary ? 'domains.unprimaryOf' : 'domains.primaryOf', {
                host: domain.host,
              })}
              onClick={() =>
                void change(
                  async () =>
                    (
                      await update.mutateAsync({
                        id: domain.id,
                        domain: { isPrimary: !domain.isPrimary },
                      })
                    ).domainUpdate,
                )
              }
            >
              {t(domain.isPrimary ? 'domains.unprimary' : 'domains.makePrimary')}
            </Button>
          )}
          <Button
            variant="danger"
            icon={<Trash2 aria-hidden className="size-5" />}
            aria-label={t('domains.deleteOf', { host: domain.host })}
            onClick={() => setAsking(true)}
          />
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/**
 * The shop's domains (ONB-07, ADR-264): its own domains connected, pointed at Hatti by a CNAME
 * record and checked, one made primary, where the storefront sends shoppers, and let go; the
 * Hatti address always answering. A plan without domains of its own, such as Free, adds none,
 * the core says why, and keeps those connected before.
 */
export function DomainsPage() {
  const { t } = useLocale();
  const query = useAdminQuery<ShopDomainsData>(['domains'], ShopDomainsQuery);
  const create = useAdminMutation<{ domainCreate: Payload }, { domain: { host: string } }>(
    DomainCreateMutation,
  );
  const { problem, change } = useChange();
  const [host, setHost] = useState('');

  const onAdd = (event: FormEvent) => {
    event.preventDefault();
    void change(
      async () => (await create.mutateAsync({ domain: { host: host.trim() } })).domainCreate,
    ).then((ok) => ok && setHost(''));
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Globe aria-hidden className="size-7 text-secondary" />
        {t('domains.title')}
      </h1>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : (
        <>
          <p className="text-secondary">
            {t('domains.storeAt')}{' '}
            <a
              href={query.data.shop.url}
              target="_blank"
              rel="noreferrer"
              className="num font-medium text-primary hover:underline"
              dir="ltr"
            >
              {query.data.shop.url.replace(/^https?:\/\//, '')}
            </a>
          </p>
          {query.data.domains.length > 0 && (
            <Card>
              <ul className="divide-y divide-line">
                {query.data.domains.map((domain) => (
                  <DomainRow key={domain.id} domain={domain} />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
      <FormSection title={t('domains.add')} hint={t('domains.addHint')}>
        <form onSubmit={onAdd} className="flex flex-wrap items-end gap-2">
          <TextField
            label={t('domains.host')}
            placeholder="www.zarifashions.pk"
            ltr
            inputMode="url"
            autoCapitalize="none"
            className="min-w-56 flex-1"
            value={host}
            onChange={(event) => setHost(event.target.value)}
          />
          <Button
            type="submit"
            busy={create.isPending}
            disabled={!host.trim()}
            icon={<Plus aria-hidden className="size-5" />}
          >
            {t('domains.addSubmit')}
          </Button>
        </form>
        {problem && <Alert tone="danger">{problem}</Alert>}
      </FormSection>
    </div>
  );
}
