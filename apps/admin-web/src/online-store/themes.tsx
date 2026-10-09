import { Copy, ExternalLink, Palette, Plus, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ThemeCreateMutation,
  ThemeDeleteMutation,
  ThemePublishMutation,
  ThemesQuery,
} from '../api/operations';
import type { OnlineStoreTheme, ThemesData, UserError } from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatDate, formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** Those who change the shop's themes: its owner and managers, as the core allows. */
export const EDITS_THEMES: readonly StaffRole[] = ['owner', 'manager'];

/** The choice, when adding a theme, of starting from the platform theme rather than a copy. */
const PLATFORM = '';

/** Runs a change of a theme and says what went wrong, the core's words or the network's. */
function useChange() {
  const { t } = useLocale();
  const [problem, setProblem] = useState<string | null>(null);
  const change = async (run: () => Promise<{ userErrors: UserError[] }>): Promise<boolean> => {
    setProblem(null);
    try {
      const error = (await run()).userErrors[0];
      if (error) {
        // A theme's name is the one field the core names; the product form's words do not fit.
        setProblem(
          error.field?.at(-1) === 'name' ? `${t('themes.name')}: ${error.message}` : error.message,
        );
      }
      return !error;
    } catch (failure) {
      setProblem(errorText(failure, t));
      return false;
    }
  };
  return { problem, change };
}

/** One theme: looked at through its preview link, published, or deleted once asked. */
function ThemeRow({ theme }: { theme: OnlineStoreTheme }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const publish = useAdminMutation<{ themePublish: { userErrors: UserError[] } }, { id: string }>(
    ThemePublishMutation,
  );
  const remove = useAdminMutation<{ themeDelete: { userErrors: UserError[] } }, { id: string }>(
    ThemeDeleteMutation,
  );
  const { problem, change } = useChange();
  const [asking, setAsking] = useState<'publish' | 'delete' | null>(null);
  const main = theme.role === 'MAIN';

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold" dir="auto">
          {theme.name}
        </span>
        {main && (
          <span className="rounded-full bg-primary px-2 text-on-primary text-[length:var(--hatti-type-body-sm-size)] font-medium">
            {t('themes.live')}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('themes.dates', {
            added: formatDate(theme.createdAt, timezone, locale),
            changed: formatRelative(theme.updatedAt, timezone, locale),
          })}
        </span>
      </div>
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('themes.base', { base: theme.base })}
      </span>
      {asking ? (
        <Alert tone="warning">
          <p>
            {asking === 'publish'
              ? t('themes.publishAsk', { name: theme.name })
              : t('themes.deleteAsk', { name: theme.name })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant={asking === 'delete' ? 'destructive' : 'primary'}
              busy={publish.isPending || remove.isPending}
              onClick={() =>
                void change(async () =>
                  asking === 'publish'
                    ? (await publish.mutateAsync({ id: theme.id })).themePublish
                    : (await remove.mutateAsync({ id: theme.id })).themeDelete,
                ).then(() => setAsking(null))
              }
            >
              {asking === 'publish' ? t('themes.publishSure') : t('themes.deleteSure')}
            </Button>
            <Button variant="secondary" onClick={() => setAsking(null)}>
              {t('action.back')}
            </Button>
          </div>
        </Alert>
      ) : (
        <div className="flex flex-wrap gap-2">
          <a
            href={theme.previewUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={t('themes.previewOf', { name: theme.name })}
            className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium md:min-h-10"
          >
            <ExternalLink aria-hidden className="size-5" />
            {t('themes.preview')}
          </a>
          {!main && (
            <>
              <Button
                variant="secondary"
                icon={<Upload aria-hidden className="size-5" />}
                aria-label={t('themes.publishOf', { name: theme.name })}
                onClick={() => setAsking('publish')}
              >
                {t('themes.publish')}
              </Button>
              <Button
                variant="danger"
                icon={<Trash2 aria-hidden className="size-5" />}
                aria-label={t('themes.deleteOf', { name: theme.name })}
                onClick={() => setAsking('delete')}
              />
            </>
          )}
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/** A theme added: a copy of one the shop has, the main one to begin with, or the platform's. */
function AddTheme({ themes }: { themes: OnlineStoreTheme[] }) {
  const { t } = useLocale();
  const create = useAdminMutation<
    { themeCreate: { userErrors: UserError[] } },
    { name: string; copyFrom: string | null }
  >(ThemeCreateMutation);
  const { problem, change } = useChange();
  const main = themes.find((theme) => theme.role === 'MAIN');
  const [from, setFrom] = useState(main?.id ?? PLATFORM);
  const [name, setName] = useState('');

  const onAdd = (event: FormEvent) => {
    event.preventDefault();
    void change(
      async () =>
        (await create.mutateAsync({ name: name.trim(), copyFrom: from || null })).themeCreate,
    ).then((ok) => ok && setName(''));
  };

  return (
    <FormSection title={t('themes.add')} hint={t('themes.addHint')}>
      <form onSubmit={onAdd} className="flex flex-col gap-3">
        <SelectField
          label={t('themes.from')}
          value={from}
          options={[
            ...themes.map((theme) => ({
              value: theme.id,
              label: t('themes.copyOf', { name: theme.name }),
            })),
            { value: PLATFORM, label: t('themes.platform') },
          ]}
          onChange={setFrom}
        />
        <TextField
          label={t('themes.name')}
          dir="auto"
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={create.isPending}
          disabled={!name.trim()}
          icon={
            from ? <Copy aria-hidden className="size-5" /> : <Plus aria-hidden className="size-5" />
          }
        >
          {t('themes.addSubmit')}
        </Button>
      </form>
    </FormSection>
  );
}

/**
 * The online store's themes (OS-02): the one the storefront shows, and those being prepared,
 * each looked at through a link that shows it on the storefront, published once asked, or
 * deleted; a theme added as a copy of one the shop has, to change without touching the live one,
 * or on the platform theme afresh. Its files are changed in the theme editor, to come.
 */
export function ThemesTab() {
  const { t } = useLocale();
  const query = useAdminQuery<ThemesData>(['themes'], ThemesQuery);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  // The live theme first, then those being prepared, the latest changed first.
  const themes = [...query.data.themes.nodes].sort(
    (a, b) =>
      Number(b.role === 'MAIN') - Number(a.role === 'MAIN') ||
      b.updatedAt.localeCompare(a.updatedAt),
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-center gap-2 text-secondary">
        <Palette aria-hidden className="size-5" />
        {t('themes.hint')}
      </p>
      <Card>
        <ul className="divide-y divide-line" aria-label={t('themes.list')}>
          {themes.map((theme) => (
            <ThemeRow key={theme.id} theme={theme} />
          ))}
        </ul>
      </Card>
      <AddTheme themes={themes} />
    </div>
  );
}
