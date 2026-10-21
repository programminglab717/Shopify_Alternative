import { CalendarClock, History, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ThemeRollbackMutation,
  ThemeSchedulePublishMutation,
  ThemeVersionsQuery,
} from '../api/operations';
import type { OnlineStoreTheme, ThemeVersion, ThemeVersionsData, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime, formatRelative, localInput } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

type Change = (run: () => Promise<{ userErrors: UserError[] }>) => Promise<boolean>;

/**
 * The changes a theme keeps (OS-03, ADR-694), the newest first and the newest the theme as it
 * is: each with what made it and the files it touched, and the theme taken back to one once
 * asked, the changes since undone as a change of its own, which can be undone in turn.
 */
export function ThemeVersions({ theme, change }: { theme: OnlineStoreTheme; change: Change }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const query = useAdminQuery<ThemeVersionsData>(['themeVersions', theme.id], ThemeVersionsQuery, {
    id: theme.id,
  });
  const rollback = useAdminMutation<
    { themeRollback: { userErrors: UserError[] } },
    { id: string; version: number }
  >(ThemeRollbackMutation);
  const [asking, setAsking] = useState<number | null>(null);
  const [done, setDone] = useState<number | null>(null);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const versions = query.data.theme?.versions ?? [];
  if (versions.length === 0) {
    return (
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('themes.versionsNone')}
      </p>
    );
  }

  const onRollback = (version: number) =>
    void change(
      async () => (await rollback.mutateAsync({ id: theme.id, version })).themeRollback,
    ).then((ok) => {
      setAsking(null);
      setDone(ok ? version : null);
    });

  const row = (each: ThemeVersion, at: number) => (
    <li key={each.version} className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{t('themes.version', { version: each.version })}</span>
        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t(`themes.cause.${each.cause}`)} · {formatRelative(each.createdAt, timezone, locale)}
        </span>
        {at === 0 && (
          <span className="rounded-full border border-line px-2 text-[length:var(--hatti-type-body-sm-size)]">
            {t('themes.versionNow')}
          </span>
        )}
        <span className="flex-1" />
        {at > 0 && asking !== each.version && (
          <Button
            variant="secondary"
            icon={<Undo2 aria-hidden className="size-5" />}
            aria-label={t('themes.rollbackOf', { version: each.version })}
            onClick={() => {
              setDone(null);
              setAsking(each.version);
            }}
          >
            {t('themes.rollback')}
          </Button>
        )}
      </div>
      <span
        className="text-secondary text-[length:var(--hatti-type-body-sm-size)] break-all"
        dir="ltr"
      >
        {each.changedFiles.join(', ')}
      </span>
      {asking === each.version && (
        <Alert tone="warning">
          <p>{t('themes.rollbackAsk', { name: theme.name, version: each.version })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button busy={rollback.isPending} onClick={() => onRollback(each.version)}>
              {t('themes.rollbackSure')}
            </Button>
            <Button variant="secondary" onClick={() => setAsking(null)}>
              {t('action.back')}
            </Button>
          </div>
        </Alert>
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-2">
      {done !== null && <Alert tone="success">{t('themes.rolledBack', { version: done })}</Alert>}
      <ol
        className="divide-y divide-line"
        aria-label={t('themes.versionsOf', { name: theme.name })}
      >
        {versions.map(row)}
      </ol>
    </div>
  );
}

/** Toggles a theme's versions open under its row. */
export function VersionsButton({
  theme,
  open,
  onToggle,
}: {
  theme: OnlineStoreTheme;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useLocale();
  return (
    <Button
      variant="secondary"
      icon={<History aria-hidden className="size-5" />}
      aria-label={t('themes.versionsOf', { name: theme.name })}
      aria-expanded={open}
      onClick={onToggle}
    >
      {t('themes.versions')}
    </Button>
  );
}

/**
 * A theme published by itself at a time ahead (OS-03, ADR-695), for the Eid look at midnight:
 * the time typed in the phone's own time, as a product's is, and said back in the shop's.
 */
export function ThemeSchedule({
  theme,
  change,
  onDone,
}: {
  theme: OnlineStoreTheme;
  change: Change;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const schedule = useAdminMutation<
    { themeSchedulePublish: { userErrors: UserError[] } },
    { id: string; publishAt: string | null }
  >(ThemeSchedulePublishMutation);
  const [at, setAt] = useState(theme.publishAt ? localInput(theme.publishAt) : '');

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    void change(
      async () =>
        (await schedule.mutateAsync({ id: theme.id, publishAt: new Date(at).toISOString() }))
          .themeSchedulePublish,
    ).then((ok) => ok && onDone());
  };

  return (
    <form onSubmit={onSave} className="flex flex-col gap-3">
      <TextField
        label={t('themes.scheduleAt')}
        hint={t('themes.scheduleHint')}
        type="datetime-local"
        ltr
        required
        value={at}
        onChange={(event) => setAt(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          busy={schedule.isPending}
          disabled={!at}
          icon={<CalendarClock aria-hidden className="size-5" />}
        >
          {t('themes.scheduleSure')}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {t('action.back')}
        </Button>
      </div>
    </form>
  );
}

/** When a theme is to be published, said in the shop's time, and the time taken away. */
export function ScheduledNote({
  theme,
  change,
}: {
  theme: OnlineStoreTheme & { publishAt: string };
  change: Change;
}) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const schedule = useAdminMutation<
    { themeSchedulePublish: { userErrors: UserError[] } },
    { id: string; publishAt: string | null }
  >(ThemeSchedulePublishMutation);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <CalendarClock aria-hidden className="size-5 text-secondary" />
      <span>
        {t('themes.scheduled', { date: formatDateTime(theme.publishAt, timezone, locale) })}
      </span>
      <Button
        variant="tertiary"
        busy={schedule.isPending}
        aria-label={t('themes.unscheduleOf', { name: theme.name })}
        onClick={() =>
          void change(
            async () =>
              (await schedule.mutateAsync({ id: theme.id, publishAt: null })).themeSchedulePublish,
          )
        }
      >
        {t('themes.unschedule')}
      </Button>
    </div>
  );
}
