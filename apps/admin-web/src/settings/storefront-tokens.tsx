import { Code2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  StorefrontAccessTokenCreateMutation,
  StorefrontAccessTokenDeleteMutation,
  StorefrontAccessTokensQuery,
} from '../api/operations';
import type {
  StorefrontAccessTokenCreateData,
  StorefrontAccessTokenDeleteData,
  StorefrontAccessTokensData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { SelectField } from './settings-form';

/**
 * The shop's Storefront API tokens (DEV-02, ADR-848), for a headless storefront or a shopping
 * app: public, sent from shoppers' browsers, or private, kept on a server. Each is shown once,
 * as it is made, with the address it is sent to.
 */
export function StorefrontTokens() {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const query = useAdminQuery<StorefrontAccessTokensData>(
    ['storefrontAccessTokens'],
    StorefrontAccessTokensQuery,
  );
  const create = useAdminMutation<
    StorefrontAccessTokenCreateData,
    { input: { title: string; private: boolean } }
  >(StorefrontAccessTokenCreateMutation);
  const remove = useAdminMutation<StorefrontAccessTokenDeleteData, { id: string }>(
    StorefrontAccessTokenDeleteMutation,
  );
  const [making, setMaking] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'public' | 'private'>('public');
  const [shown, setShown] = useState<{ title: string; token: string; private: boolean } | null>(
    null,
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { storefrontAccessTokenCreate: made } = await create.mutateAsync({
        input: { title, private: kind === 'private' },
      });
      if (made.userErrors[0]) {
        setProblem(problemText(made.userErrors[0], t));
        return;
      }
      const token = made.storefrontAccessToken!;
      setShown({ title: token.title, token: token.accessToken ?? '', private: token.private });
      setMaking(false);
      setTitle('');
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const onRemove = async (id: string) => {
    setProblem(null);
    try {
      const { storefrontAccessTokenDelete: removed } = await remove.mutateAsync({ id });
      if (removed.userErrors[0]) setProblem(problemText(removed.userErrors[0], t));
      setRemoving(null);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const shopUrl = query.data?.shop?.url ?? null;
  const endpoint = shopUrl && `${shopUrl.replace(/\/+$/, '')}/api/2026-10/graphql.json`;
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
    const tokens = query.data.storefrontAccessTokens;
    return (
      <>
        {shown && (
          <Card className="flex flex-col gap-2 p-4">
            <Alert tone="warning">{t('storefrontApi.shownOnce', { title: shown.title })}</Alert>
            <code className="num break-all rounded-control bg-canvas px-2 py-1" dir="ltr">
              {shown.token}
            </code>
            <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t(shown.private ? 'storefrontApi.sendPrivate' : 'storefrontApi.sendPublic')}
            </span>
            <Button className="self-start" onClick={() => setShown(null)}>
              {t('apps.done')}
            </Button>
          </Card>
        )}
        {making ? (
          <Card className="p-4">
            <form className="flex flex-col gap-3" onSubmit={(event) => void onCreate(event)}>
              <TextField
                label={t('storefrontApi.name')}
                value={title}
                maxLength={100}
                onChange={(event) => setTitle(event.target.value)}
              />
              <SelectField
                label={t('storefrontApi.kind')}
                value={kind}
                options={[
                  { value: 'public', label: t('storefrontApi.public') },
                  { value: 'private', label: t('storefrontApi.private') },
                ]}
                onChange={(value) => setKind(value as 'public' | 'private')}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" busy={create.isPending}>
                  {t('storefrontApi.create')}
                </Button>
                <Button variant="tertiary" onClick={() => setMaking(false)}>
                  {t('action.back')}
                </Button>
              </div>
            </form>
          </Card>
        ) : (
          <Button
            variant="secondary"
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => {
              setShown(null);
              setMaking(true);
            }}
          >
            {t('storefrontApi.make')}
          </Button>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {tokens.length > 0 && (
          <Card>
            <ul className="divide-y divide-line">
              {tokens.map((token) => (
                <li
                  key={token.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
                >
                  <span className="flex flex-1 flex-col">
                    <span className="font-medium" dir="auto">
                      {token.title}
                    </span>
                    <span className="num text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                      {t(token.private ? 'storefrontApi.private' : 'storefrontApi.public')}
                      {' · '}
                      {t('apps.tokenEnds', { hint: token.hint })}
                      {' · '}
                      {t('apps.made', { date: formatDate(token.createdAt, timezone, locale) })}
                    </span>
                  </span>
                  {removing === token.id ? (
                    <>
                      <span>{t('storefrontApi.removeSure', { title: token.title })}</span>
                      <Button
                        variant="destructive"
                        busy={remove.isPending}
                        onClick={() => void onRemove(token.id)}
                      >
                        {t('apps.removeYes')}
                      </Button>
                      <Button variant="tertiary" onClick={() => setRemoving(null)}>
                        {t('action.back')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="danger"
                      icon={<Trash2 aria-hidden className="size-5" />}
                      aria-label={t('storefrontApi.remove', { title: token.title })}
                      onClick={() => setRemoving(token.id)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </>
    );
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="storefront-api">
      <h2
        id="storefront-api"
        className="flex items-center gap-2 text-[length:var(--hatti-type-title-size)] font-semibold"
      >
        <Code2 aria-hidden className="size-6 text-secondary" />
        {t('storefrontApi.title')}
      </h2>
      <p className="text-secondary">{t('storefrontApi.hint')}</p>
      {endpoint && (
        <code className="num break-all text-secondary" dir="ltr">
          {endpoint}
        </code>
      )}
      {body()}
    </section>
  );
}
