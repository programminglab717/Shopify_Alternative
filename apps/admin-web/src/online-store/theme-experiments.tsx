import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ThemeExperimentEndMutation,
  ThemeExperimentStartMutation,
  ThemeExperimentsQuery,
} from '../api/operations';
import type {
  OnlineStoreTheme,
  ThemeExperiment,
  ThemeExperimentArm,
  ThemeExperimentPayloadData,
  ThemeExperimentsData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

/**
 * Theme experiments (OS-22, ADR-866): a draft of the shop's theme shown a share of its shoppers,
 * the rest the live theme, for up to 30 days; each arm's sessions, carts, checkouts and orders,
 * and once each has sessions enough, whether the draft sells better or worse. Hatti ends one
 * whose draft sells clearly worse.
 */
export function ThemeExperiments({ themes }: { themes: readonly OnlineStoreTheme[] }) {
  const { t } = useLocale();
  const query = useAdminQuery<ThemeExperimentsData>(['themeExperiments'], ThemeExperimentsQuery);
  const start = useAdminMutation<
    ThemeExperimentPayloadData,
    { input: { name: string; themeId: string; share: number; days: number } }
  >(ThemeExperimentStartMutation);
  const end = useAdminMutation<ThemeExperimentPayloadData, { id: string }>(
    ThemeExperimentEndMutation,
  );
  const drafts = themes.filter((theme) => theme.role === 'UNPUBLISHED');
  const [name, setName] = useState('');
  const [themeId, setThemeId] = useState('');
  const [share, setShare] = useState('20');
  const [days, setDays] = useState('14');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<ThemeExperimentPayloadData>) => {
    setProblem(null);
    setBusy(true);
    try {
      const done = await work();
      const errors = (done.themeExperimentStart ?? done.themeExperimentEnd)?.userErrors ?? [];
      if (errors[0]) setProblem(problemText(errors[0], t));
      else setName('');
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
    setBusy(false);
  };

  const onStart = (event: FormEvent) => {
    event.preventDefault();
    void run(() =>
      start.mutateAsync({
        input: {
          name: name.trim(),
          themeId: themeId || drafts[0]!.id,
          share: Number(share),
          days: Number(days),
        },
      }),
    );
  };

  const experiments = query.data?.themeExperiments ?? [];
  const running = experiments.find((each) => each.endedAt === null) ?? null;
  const past = experiments.filter((each) => each.endedAt !== null).slice(0, 5);
  const themeName = (id: string) => themes.find((theme) => theme.id === id)?.name ?? '—';

  return (
    <section aria-labelledby="theme-experiments" className="flex flex-col gap-2">
      <h2 id="theme-experiments" className="flex items-center gap-2 font-semibold">
        <FlaskConical aria-hidden className="size-5 text-secondary" />
        {t('experiments.title')}
      </h2>
      <Card className="flex flex-col gap-3 p-4">
        <p className="text-secondary">{t('experiments.hint')}</p>
        {query.isPending ? (
          <Loading label={t('state.loading')} />
        ) : running ? (
          <>
            <Results experiment={running} draftName={themeName(running.themeId)} />
            <Button
              variant="danger"
              className="self-start"
              busy={busy}
              onClick={() => void run(() => end.mutateAsync({ id: running.id }))}
            >
              {t('experiments.end')}
            </Button>
          </>
        ) : drafts.length === 0 ? (
          <p className="text-secondary">{t('experiments.noDrafts')}</p>
        ) : (
          <form onSubmit={onStart} className="flex flex-col gap-3">
            <TextField
              label={t('experiments.name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
            <SelectField
              label={t('experiments.draft')}
              value={themeId || drafts[0]!.id}
              options={drafts.map((theme) => ({ value: theme.id, label: theme.name }))}
              onChange={setThemeId}
            />
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label={t('experiments.share')}
                hint={t('experiments.shareHint')}
                inputMode="numeric"
                value={share}
                onChange={(event) => setShare(event.target.value)}
              />
              <TextField
                label={t('experiments.days')}
                inputMode="numeric"
                value={days}
                onChange={(event) => setDays(event.target.value)}
              />
            </div>
            <Button type="submit" className="self-start" busy={busy}>
              {t('experiments.start')}
            </Button>
          </form>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {past.length > 0 && (
          <ul className="divide-y divide-line" aria-label={t('experiments.past')}>
            {past.map((experiment) => (
              <li key={experiment.id} className="py-2">
                <Results experiment={experiment} draftName={themeName(experiment.themeId)} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function Results({ experiment, draftName }: { experiment: ThemeExperiment; draftName: string }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const arm = (label: string, counts: ThemeExperimentArm) => (
    <li className="flex flex-wrap justify-between gap-2">
      <span className="font-medium" dir="auto">
        {label}
      </span>
      <span className="text-secondary">
        {t('experiments.counts', {
          sessions: counts.sessions,
          carts: counts.addedToCart,
          orders: counts.converted,
          rate: percent(counts.conversionRate),
        })}
      </span>
    </li>
  );
  return (
    <div className="flex flex-col gap-2">
      <p className="font-semibold" dir="auto">
        {experiment.name}
      </p>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {experiment.endedAt
          ? t(`experiments.ended.${experiment.endedReason ?? 'staff'}` as MessageKey, {
              date: formatDate(experiment.endedAt, timezone, locale),
            })
          : t('experiments.running', {
              share: experiment.share,
              date: formatDate(experiment.endsAt, timezone, locale),
            })}
      </p>
      <ul className="flex flex-col gap-1">
        {arm(t('experiments.live'), experiment.live)}
        {arm(t('experiments.draftArm', { name: draftName }), experiment.draft)}
      </ul>
      <Alert tone={experiment.verdict === 'b_worse' ? 'warning' : 'info'}>
        {t(`experiments.verdict.${experiment.verdict}` as MessageKey)}
      </Alert>
    </div>
  );
}
