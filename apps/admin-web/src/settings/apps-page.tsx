import { Blocks, Copy, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  CustomAppCreateMutation,
  CustomAppDeleteMutation,
  CustomAppSecretRotateMutation,
  CustomAppTokenRotateMutation,
  CustomAppUpdateMutation,
  CustomAppsQuery,
  WebhookSubscriptionsQuery,
} from '../api/operations';
import type {
  CustomApp,
  CustomAppCreateData,
  CustomAppDeleteData,
  CustomAppInput,
  CustomAppSecretRotateData,
  CustomAppTokenRotateData,
  CustomAppUpdateData,
  CustomAppsData,
  UserError,
  WebhookSubscriptionsData,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection } from '../products/product-form';
import { SelectField } from './settings-form';
import { AppWebhooks } from './app-webhooks';
import { AppEmbeds } from './app-embeds';
import { AppFunctions } from './app-functions';
import { InstalledApps } from './installed-apps';
import { StorefrontTokens } from './storefront-tokens';
import { BackToSettings } from './settings-page';

/**
 * What an app may reach, as the API's scopes name it: each read alone, or read and write where the
 * API has a write. In the order the API lists them.
 */
const RESOURCES = [
  { name: 'products', write: true },
  { name: 'inventory', write: true },
  { name: 'locations', write: true },
  { name: 'orders', write: true },
  { name: 'customers', write: true },
  { name: 'segments', write: true },
  { name: 'discounts', write: true },
  { name: 'store_credit_accounts', write: false },
  { name: 'store_credit_account_transactions', write: true },
  { name: 'files', write: true },
  { name: 'content', write: true },
  { name: 'online_store_pages', write: true },
  { name: 'online_store_navigation', write: true },
  { name: 'themes', write: true },
  { name: 'translations', write: true },
  { name: 'legal_policies', write: true },
  { name: 'domains', write: true },
  { name: 'pixels', write: true },
  { name: 'marketing_events', write: true },
  { name: 'settings', write: true },
] as const;
type Resource = (typeof RESOURCES)[number]['name'];
type Access = 'none' | 'read' | 'write';
type AccessMap = Record<Resource, Access>;

const NO_ACCESS = Object.fromEntries(RESOURCES.map(({ name }) => [name, 'none'])) as AccessMap;

/** An app's scopes as each resource's access: a write is read and write. */
function accessOf(scopes: readonly string[]): AccessMap {
  const access = { ...NO_ACCESS };
  for (const { name } of RESOURCES) {
    if (scopes.includes(`write_${name}`)) access[name] = 'write';
    else if (scopes.includes(`read_${name}`)) access[name] = 'read';
  }
  return access;
}

/** The scopes each resource's access asks for. */
function scopesOf(access: AccessMap): string[] {
  return RESOURCES.flatMap(({ name }) =>
    access[name] === 'none' ? [] : [`${access[name]}_${name}`],
  );
}

function failedWith(errors: UserError[], t: Parameters<typeof problemText>[1]): string | null {
  return errors[0] ? problemText(errors[0], t) : null;
}

/** A token or secret shown this once, with a way to copy it. */
function Secret({ label, value }: { label: string; value: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      <code className="num break-all rounded-control bg-canvas px-2 py-1" dir="ltr">
        {value}
      </code>
      <Button
        variant="secondary"
        className="self-start"
        icon={<Copy aria-hidden className="size-5" />}
        onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true))}
      >
        {copied ? t('staff.copied') : t('apps.copy')}
      </Button>
    </div>
  );
}

/** What was just made: the app's token, its secret, or both, never shown again. */
interface Shown {
  name: string;
  accessToken: string | null;
  webhookSecret: string | null;
}

function ShownOnce({ shown, onDone }: { shown: Shown; onDone: () => void }) {
  const { t } = useLocale();
  return (
    <Card className="flex flex-col gap-3 p-4">
      <Alert tone="warning">{t('apps.shownOnce', { name: shown.name })}</Alert>
      {shown.accessToken && <Secret label={t('apps.accessToken')} value={shown.accessToken} />}
      {shown.webhookSecret && (
        <Secret label={t('apps.webhookSecret')} value={shown.webhookSecret} />
      )}
      <Button className="self-start" onClick={onDone}>
        {t('apps.done')}
      </Button>
    </Card>
  );
}

/** Making an app, or changing one's name and what it may reach. */
function AppForm({
  app,
  onSaved,
  onCancel,
}: {
  app: CustomApp | null;
  onSaved: (shown: Shown | null) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const create = useAdminMutation<CustomAppCreateData, { input: CustomAppInput }>(
    CustomAppCreateMutation,
  );
  const update = useAdminMutation<CustomAppUpdateData, { id: string; input: CustomAppInput }>(
    CustomAppUpdateMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const [name, setName] = useState(app?.name ?? '');
  const [access, setAccess] = useState<AccessMap>(app ? accessOf(app.scopes) : NO_ACCESS);
  const [problem, setProblem] = useState<string | null>(null);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const input = { name, scopes: scopesOf(access) };
    void run(
      async () => {
        if (app) {
          const { customAppUpdate } = await update.mutateAsync({ id: app.id, input });
          const failed = failedWith(customAppUpdate.userErrors, t);
          if (failed) setProblem(failed);
          else onSaved(null);
        } else {
          const { customAppCreate } = await create.mutateAsync({ input });
          const failed = failedWith(customAppCreate.userErrors, t);
          if (failed) setProblem(failed);
          else {
            onSaved({
              name: customAppCreate.customApp!.name,
              accessToken: customAppCreate.accessToken,
              webhookSecret: customAppCreate.webhookSecret,
            });
          }
        }
      },
      (failure) => setProblem(errorText(failure, t)),
    );
  };

  return (
    <>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <FormSection title={app ? t('apps.change', { name: app.name }) : t('apps.make')}>
          <TextField
            label={t('apps.name')}
            hint={t('apps.nameHint')}
            dir="auto"
            maxLength={100}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="text-secondary">{t('apps.accessHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {RESOURCES.map(({ name: resource, write }) => (
              <SelectField<Access>
                key={resource}
                label={t(`apps.resource.${resource}` as MessageKey)}
                value={access[resource]}
                options={[
                  { value: 'none', label: t('apps.access.none') },
                  { value: 'read', label: t('apps.access.read') },
                  ...(write ? [{ value: 'write' as const, label: t('apps.access.write') }] : []),
                ]}
                onChange={(value) => setAccess((all) => ({ ...all, [resource]: value }))}
              />
            ))}
          </div>
          {problem && <Alert tone="danger">{problem}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={create.isPending || update.isPending}>
              {app ? t('apps.save') : t('apps.create')}
            </Button>
            <Button variant="tertiary" onClick={onCancel}>
              {t('action.back')}
            </Button>
          </div>
        </FormSection>
      </form>
      {panel}
    </>
  );
}

/** What an app may reach, in words: "Orders: read and write · Products: read". */
function AccessWords({ scopes }: { scopes: readonly string[] }) {
  const { t } = useLocale();
  const access = accessOf(scopes);
  if (RESOURCES.every(({ name, write }) => access[name] === (write ? 'write' : 'read'))) {
    return <span className="text-secondary">{t('apps.everything')}</span>;
  }
  const words = RESOURCES.filter(({ name }) => access[name] !== 'none').map(({ name }) =>
    t('apps.reaches', {
      resource: t(`apps.resource.${name}` as MessageKey),
      access: t(`apps.access.${access[name]}` as MessageKey),
    }),
  );
  return <span className="text-secondary">{words.join(' · ')}</span>;
}

/**
 * The shop's custom apps (DEV-04, ADR-395), for owners and managers: each with what it may reach
 * and the last characters of its token and secret; one made, changed, given a new token or secret,
 * or removed. A token or secret is shown once, when it is made, to copy into the app.
 */
export function AppsPage() {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const query = useAdminQuery<CustomAppsData>(['customApps'], CustomAppsQuery);
  const webhooks = useAdminQuery<WebhookSubscriptionsData>(
    ['webhookSubscriptions'],
    WebhookSubscriptionsQuery,
  );
  const rotateToken = useAdminMutation<CustomAppTokenRotateData, { id: string }>(
    CustomAppTokenRotateMutation,
  );
  const rotateSecret = useAdminMutation<CustomAppSecretRotateData, { id: string }>(
    CustomAppSecretRotateMutation,
  );
  const remove = useAdminMutation<CustomAppDeleteData, { id: string }>(CustomAppDeleteMutation);
  const { run, panel } = useRecentAuthentication();
  const [editing, setEditing] = useState<CustomApp | 'new' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const onError = (failure: unknown) => setProblem(errorText(failure, t));

  const onToken = (app: CustomApp) => {
    setProblem(null);
    void run(async () => {
      const { customAppTokenRotate } = await rotateToken.mutateAsync({ id: app.id });
      const failed = failedWith(customAppTokenRotate.userErrors, t);
      if (failed) setProblem(failed);
      else {
        setShown({
          name: app.name,
          accessToken: customAppTokenRotate.accessToken,
          webhookSecret: null,
        });
      }
    }, onError);
  };

  const onSecret = (app: CustomApp) => {
    setProblem(null);
    void run(async () => {
      const { customAppSecretRotate } = await rotateSecret.mutateAsync({ id: app.id });
      const failed = failedWith(customAppSecretRotate.userErrors, t);
      if (failed) setProblem(failed);
      else {
        setShown({
          name: app.name,
          accessToken: null,
          webhookSecret: customAppSecretRotate.webhookSecret,
        });
      }
    }, onError);
  };

  const onRemove = (app: CustomApp) => {
    setProblem(null);
    void run(async () => {
      const { customAppDelete } = await remove.mutateAsync({ id: app.id });
      setProblem(failedWith(customAppDelete.userErrors, t));
      setRemoving(null);
    }, onError);
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
    const apps = query.data.customApps;
    return (
      <>
        {shown && <ShownOnce shown={shown} onDone={() => setShown(null)} />}
        {editing ? (
          <AppForm
            app={editing === 'new' ? null : editing}
            onSaved={(made) => {
              setEditing(null);
              setShown(made);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <Button
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => {
              setShown(null);
              setEditing('new');
            }}
          >
            {t('apps.make')}
          </Button>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {apps.length === 0 ? (
          <EmptyState title={t('apps.none')} />
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {apps.map((app) => (
                <li key={app.id} className="flex flex-col gap-2 px-4 py-3">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-medium" dir="auto">
                      {app.name}
                    </span>
                    <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                      {t('apps.made', { date: formatDate(app.createdAt, timezone, locale) })}
                    </span>
                  </span>
                  <AccessWords scopes={app.scopes} />
                  <span className="num text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {t('apps.tokenEnds', { hint: app.tokenHint })}
                    {' · '}
                    {app.secretHint
                      ? t('apps.secretEnds', { hint: app.secretHint })
                      : t('apps.noSecret')}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {removing === app.id ? (
                      <>
                        <span>{t('apps.removeSure', { name: app.name })}</span>
                        <Button
                          variant="destructive"
                          busy={remove.isPending}
                          onClick={() => onRemove(app)}
                        >
                          {t('apps.removeYes')}
                        </Button>
                        <Button variant="tertiary" onClick={() => setRemoving(null)}>
                          {t('action.back')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="secondary"
                          icon={<Pencil aria-hidden className="size-5" />}
                          onClick={() => {
                            setShown(null);
                            setEditing(app);
                          }}
                        >
                          {t('apps.edit')}
                        </Button>
                        <Button
                          variant="secondary"
                          busy={rotateToken.isPending && rotateToken.variables?.id === app.id}
                          icon={<RefreshCw aria-hidden className="size-5" />}
                          onClick={() => onToken(app)}
                        >
                          {t('apps.newToken')}
                        </Button>
                        <Button
                          variant="secondary"
                          busy={rotateSecret.isPending && rotateSecret.variables?.id === app.id}
                          icon={<KeyRound aria-hidden className="size-5" />}
                          onClick={() => onSecret(app)}
                        >
                          {app.secretHint ? t('apps.newSecret') : t('apps.makeSecret')}
                        </Button>
                        <Button
                          variant="danger"
                          icon={<Trash2 aria-hidden className="size-5" />}
                          aria-label={t('apps.remove', { name: app.name })}
                          onClick={() => setRemoving(app.id)}
                        />
                      </>
                    )}
                  </div>
                  {webhooks.data && (
                    <AppWebhooks
                      app={app}
                      subscriptions={webhooks.data.webhookSubscriptions.filter(
                        (subscription) => subscription.appId === app.id,
                      )}
                    />
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {panel}
      </>
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Blocks aria-hidden className="size-7 text-secondary" />
        {t('apps.title')}
      </h1>
      <p className="text-secondary">{t('apps.hint')}</p>
      {body()}
      <InstalledApps />
      <AppEmbeds />
      <AppFunctions />
      <StorefrontTokens />
    </div>
  );
}
