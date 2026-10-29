import { FlaskConical } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ThemeExperimentEndMutation,
  ThemeExperimentSharesSetMutation,
  ThemeExperimentStartMutation,
  ThemeExperimentsQuery,
} from '../api/operations';
import type {
  OnlineStoreTheme,
  ThemeExperiment,
  ThemeExperimentArm,
  ThemeExperimentDraft,
  ThemeExperimentPayloadData,
  ThemeExperimentsData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDate, formatMoney } from '../i18n/format';
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
 * Theme experiments (OS-22, ADR-866): up to three drafts of the shop's theme (ADR-931), each
 * shown a share of its shoppers, the rest the live theme, for up to 30 days; each arm's sessions,
 * carts, checkouts and orders, and once each has sessions enough, whether each draft sells better
 * or worse. Hatti ends one with a draft that sells clearly worse.
 */
export function ThemeExperiments({ themes }: { themes: readonly OnlineStoreTheme[] }) {
  const { t } = useLocale();
  const query = useAdminQuery<ThemeExperimentsData>(['themeExperiments'], ThemeExperimentsQuery);
  const start = useAdminMutation<
    ThemeExperimentPayloadData,
    {
      input: {
        name: string;
        themeId: string;
        otherThemeIds: string[];
        share: number;
        otherShares?: number[];
        days: number;
      };
    }
  >(ThemeExperimentStartMutation);
  const end = useAdminMutation<ThemeExperimentPayloadData, { id: string }>(
    ThemeExperimentEndMutation,
  );
  const drafts = themes.filter((theme) => theme.role === 'UNPUBLISHED');
  const [name, setName] = useState('');
  const [themeId, setThemeId] = useState('');
  // Up to two drafts more, each its own share (ADR-931); '' for none.
  const [others, setOthers] = useState<[string, string]>(['', '']);
  // Each other draft's own share (ADR-952); '' for the first's.
  const [otherShares, setOtherShares] = useState<[string, string]>(['', '']);
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

  const first = themeId || drafts[0]?.id || '';
  const chosen = [...new Set(others.filter((id) => id !== '' && id !== first))];
  const most = Math.floor(100 / (chosen.length + 2));
  const sharesOf = chosen.map((id) => otherShares[others.indexOf(id)]?.trim() ?? '');
  const uneven = sharesOf.some((each) => each !== '');

  const onStart = (event: FormEvent) => {
    event.preventDefault();
    void run(() =>
      start.mutateAsync({
        input: {
          name: name.trim(),
          themeId: first,
          otherThemeIds: chosen,
          share: Number(share),
          ...(uneven && { otherShares: sharesOf.map((each) => Number(each || share)) }),
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
            <Results experiment={running} themeName={themeName} />
            <ChangeShares experiment={running} themeName={themeName} />
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
              value={first}
              options={drafts.map((theme) => ({ value: theme.id, label: theme.name }))}
              onChange={setThemeId}
            />
            {drafts.length > 1 &&
              ([0, 1] as const).map((index) => (
                <div key={index} className="grid grid-cols-[2fr_1fr] items-end gap-3">
                  <SelectField
                    label={t('experiments.another')}
                    value={others[index]}
                    options={[
                      { value: '', label: t('experiments.none') },
                      ...drafts
                        .filter((theme) => theme.id !== first)
                        .map((theme) => ({ value: theme.id, label: theme.name })),
                    ]}
                    onChange={(value) =>
                      setOthers((now) => (index === 0 ? [value, now[1]] : [now[0], value]))
                    }
                  />
                  {others[index] !== '' && others[index] !== first && (
                    <TextField
                      label={t('experiments.otherShare')}
                      hint={t('experiments.otherShareHint')}
                      inputMode="numeric"
                      value={otherShares[index]}
                      onChange={(event) => {
                        const value = event.target.value;
                        setOtherShares((now) => (index === 0 ? [value, now[1]] : [now[0], value]));
                      }}
                    />
                  )}
                </div>
              ))}
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label={t('experiments.share')}
                hint={
                  chosen.length > 0
                    ? t('experiments.shareHintMany', { most, count: chosen.length + 1 })
                    : t('experiments.shareHint')
                }
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
                <Results experiment={experiment} themeName={themeName} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

/**
 * Each draft's share of the running experiment, changed (ADR-958): those already shown a theme
 * keep it. A draft Hatti stopped keeps its share, and isn't asked.
 */
function ChangeShares({
  experiment,
  themeName,
}: {
  experiment: ThemeExperiment;
  themeName: (id: string) => string;
}) {
  const { t } = useLocale();
  const set = useAdminMutation<ThemeExperimentPayloadData, { id: string; shares: number[] }>(
    ThemeExperimentSharesSetMutation,
  );
  const drafts = experiment.drafts?.length
    ? experiment.drafts
    : [{ themeId: experiment.themeId, share: experiment.share, stopped: false }];
  const kept = drafts.map((draft) => String(draft.share ?? experiment.share));
  const [shares, setShares] = useState(kept);
  const [problem, setProblem] = useState<string | null>(null);
  const changed = shares.some((each, at) => each.trim() !== kept[at]);

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const done = await set.mutateAsync({
        id: experiment.id,
        shares: shares.map((each) => Number(each.trim())),
      });
      const error = done.themeExperimentSharesSet?.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-2">
      <div className="grid gap-3 sm:grid-cols-3">
        {drafts.map((draft, at) =>
          draft.stopped ? null : (
            <TextField
              key={draft.themeId}
              label={t('experiments.draftShare', { name: themeName(draft.themeId) })}
              inputMode="numeric"
              value={shares[at] ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                setShares((now) => now.map((each, index) => (index === at ? value : each)));
              }}
            />
          ),
        )}
      </div>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('experiments.sharesHint')}
      </p>
      <Button
        type="submit"
        variant="secondary"
        className="self-start"
        busy={set.isPending}
        disabled={!changed}
      >
        {t('experiments.changeShares')}
      </Button>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </form>
  );
}

function Results({
  experiment,
  themeName,
}: {
  experiment: ThemeExperiment;
  themeName: (id: string) => string;
}) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  // Experiments before several drafts list none: their one draft is `draft` (ADR-931).
  const drafts: ThemeExperimentDraft[] = experiment.drafts?.length
    ? experiment.drafts
    : [
        {
          themeId: experiment.themeId,
          arm: experiment.draft,
          verdict: experiment.verdict,
          revenueVerdict: experiment.revenueVerdict,
        },
      ];
  const many = drafts.length > 1;
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
        {' · '}
        {t('experiments.revenue', {
          amount: formatMoney(
            counts.revenuePerSession.amount,
            counts.revenuePerSession.currencyCode,
          ),
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
          : many && drafts.some((draft) => (draft.share ?? experiment.share) !== experiment.share)
            ? t('experiments.runningUneven', {
                shares: drafts.map((draft) => `${draft.share ?? experiment.share}%`).join(' · '),
                date: formatDate(experiment.endsAt, timezone, locale),
              })
            : many
              ? t('experiments.runningMany', {
                  share: experiment.share,
                  count: drafts.length,
                  date: formatDate(experiment.endsAt, timezone, locale),
                })
              : t('experiments.running', {
                  share: experiment.share,
                  date: formatDate(experiment.endsAt, timezone, locale),
                })}
      </p>
      <ul className="flex flex-col gap-1">
        {arm(t('experiments.live'), experiment.live)}
        {drafts.map((draft) => (
          <Fragment key={draft.themeId}>
            {arm(t('experiments.draftArm', { name: themeName(draft.themeId) }), draft.arm)}
          </Fragment>
        ))}
      </ul>
      {drafts.map((draft) => {
        // With several drafts, each verdict names its draft (ADR-931).
        const said = (words: string) =>
          many
            ? t('experiments.draftVerdict', { name: themeName(draft.themeId), verdict: words })
            : words;
        return (
          <Fragment key={draft.themeId}>
            {/* Stopped alone, the others going on (ADR-939). */}
            {draft.stopped && (
              <Alert tone="warning">
                {t('experiments.draftStopped', { name: themeName(draft.themeId) })}
              </Alert>
            )}
            <Alert tone={draft.verdict === 'b_worse' ? 'warning' : 'info'}>
              {said(t(`experiments.verdict.${draft.verdict}` as MessageKey))}
            </Alert>
            {/* Of money a visit, once there are visits enough to tell (ADR-921). */}
            {draft.revenueVerdict !== 'too_early' && (
              <Alert tone={draft.revenueVerdict === 'b_worse' ? 'warning' : 'info'}>
                {said(t(`experiments.revenueVerdict.${draft.revenueVerdict}` as MessageKey))}
              </Alert>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
