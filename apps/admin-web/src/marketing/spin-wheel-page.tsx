import { Disc3, Plus, Save, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { SpinWheelQuery, SpinWheelUpdateMutation } from '../api/operations';
import type {
  SpinSliceKind,
  SpinWheelData,
  SpinWheelUpdateData,
  SpinWheelValue,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { CheckField, parseWhole } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { BackToMarketing } from './templates-page';

/** A wheel has this many slices, at fewest and most (ADR-900). */
const SLICES = { min: 2, max: 8 } as const;

const KINDS: SpinSliceKind[] = ['PERCENTAGE', 'FIXED_AMOUNT', 'FREE_SHIPPING', 'NONE'];

/** A slice as the form holds it: its value as typed. */
interface SliceDraft {
  key: number;
  label: string;
  kind: SpinSliceKind;
  value: string;
  weight: string;
}

/** An amount as the core gives it, "200.00", as a merchant types it, "200". */
const rupeesOf = (amount: string) => amount.replace(/\.00$/, '');

let nextKey = 0;

function draftsOf(wheel: SpinWheelValue, t: (key: MessageKey) => string): SliceDraft[] {
  if (wheel.slices.length === 0) {
    // A start the shop changes as it likes.
    return [
      {
        key: nextKey++,
        label: t('spinWheel.example.percentage'),
        kind: 'PERCENTAGE',
        value: '10',
        weight: '1',
      },
      {
        key: nextKey++,
        label: t('spinWheel.example.shipping'),
        kind: 'FREE_SHIPPING',
        value: '',
        weight: '1',
      },
      { key: nextKey++, label: t('spinWheel.example.none'), kind: 'NONE', value: '', weight: '2' },
    ];
  }
  return wheel.slices.map((slice) => ({
    key: nextKey++,
    label: slice.label,
    kind: slice.kind,
    value:
      slice.kind === 'PERCENTAGE'
        ? String(slice.percentage ?? '')
        : slice.kind === 'FIXED_AMOUNT'
          ? rupeesOf(slice.amount?.amount ?? '')
          : '',
    weight: String(slice.weight),
  }));
}

/** A slice's row: its words, what it gives and how much, and its weight. */
function SliceRow({
  slice,
  number,
  removable,
  onChange,
  onRemove,
}: {
  slice: SliceDraft;
  number: number;
  removable: boolean;
  onChange: (slice: SliceDraft) => void;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  const kindField = useId();
  return (
    <li className="flex flex-col gap-3 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{t('spinWheel.slice', { number })}</span>
        {removable && (
          <Button
            type="button"
            variant="tertiary"
            onClick={onRemove}
            aria-label={t('spinWheel.remove', { number })}
            icon={<Trash2 aria-hidden className="size-5" />}
          />
        )}
      </div>
      <TextField
        label={t('spinWheel.label')}
        maxLength={24}
        value={slice.label}
        onChange={(event) => onChange({ ...slice, label: event.target.value })}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor={kindField} className="font-medium">
          {t('spinWheel.kind')}
        </label>
        <select
          id={kindField}
          value={slice.kind}
          onChange={(event) =>
            onChange({ ...slice, kind: event.target.value as SpinSliceKind, value: '' })
          }
          className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`spinWheel.kind.${kind}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>
      {(slice.kind === 'PERCENTAGE' || slice.kind === 'FIXED_AMOUNT') && (
        <TextField
          label={t(slice.kind === 'PERCENTAGE' ? 'spinWheel.percentage' : 'spinWheel.amount')}
          inputMode="decimal"
          ltr
          value={slice.value}
          onChange={(event) => onChange({ ...slice, value: event.target.value })}
        />
      )}
      <TextField
        label={t('spinWheel.weight')}
        hint={t('spinWheel.weightHint')}
        inputMode="numeric"
        ltr
        value={slice.weight}
        onChange={(event) => onChange({ ...slice, weight: event.target.value })}
      />
    </li>
  );
}

/** The wheel's form: on or off, its slices, its codes' days and minimum. */
function WheelForm({ wheel }: { wheel: SpinWheelValue }) {
  const { t } = useLocale();
  const update = useAdminMutation<SpinWheelUpdateData, { spinWheel: object }>(
    SpinWheelUpdateMutation,
  );
  const [enabled, setEnabled] = useState(wheel.enabled);
  const [slices, setSlices] = useState(() => draftsOf(wheel, t));
  const [days, setDays] = useState(String(wheel.codeDays));
  const [minimum, setMinimum] = useState(rupeesOf(wheel.minimumSubtotal?.amount ?? ''));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [counts, setCounts] = useState({ spins: wheel.spins, used: wheel.codesUsed });

  const change = (index: number, slice: SliceDraft) => {
    setSaved(false);
    setSlices(slices.map((each, at) => (at === index ? slice : each)));
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    const lasts = parseWhole(days);
    const weights = slices.map((slice) => parseWhole(slice.weight));
    if (
      lasts === null ||
      Number.isNaN(lasts) ||
      lasts < 1 ||
      lasts > 90 ||
      slices.some((slice) => slice.label.trim() === '') ||
      weights.some(
        (weight) => weight === null || Number.isNaN(weight) || weight < 1 || weight > 100,
      )
    ) {
      setProblem(t('spinWheel.badInput'));
      return;
    }
    try {
      const { spinWheelUpdate } = await update.mutateAsync({
        spinWheel: {
          enabled,
          slices: slices.map((slice, index) => ({
            label: slice.label.trim(),
            kind: slice.kind,
            ...(slice.kind === 'PERCENTAGE' && { percentage: Number(slice.value.trim()) }),
            ...(slice.kind === 'FIXED_AMOUNT' && { amount: slice.value.trim() }),
            weight: weights[index],
          })),
          codeDays: lasts,
          minimumSubtotal: minimum.trim() || null,
        },
      });
      const error = spinWheelUpdate.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return;
      }
      const kept = spinWheelUpdate.spinWheel;
      if (kept) {
        // As the core keeps them: "1,500" saved reads "1500".
        setSlices(draftsOf(kept, t));
        setMinimum(rupeesOf(kept.minimumSubtotal?.amount ?? ''));
        setCounts({ spins: kept.spins, used: kept.codesUsed });
      }
      setSaved(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('spinWheel.counts', { spins: counts.spins, used: counts.used })}
        </p>
        <h2 className="font-semibold">{t('spinWheel.slices')}</h2>
        <ul className="flex flex-col gap-3">
          {slices.map((slice, index) => (
            <SliceRow
              key={slice.key}
              slice={slice}
              number={index + 1}
              removable={slices.length > SLICES.min}
              onChange={(changed) => change(index, changed)}
              onRemove={() => {
                setSaved(false);
                setSlices(slices.filter((_, at) => at !== index));
              }}
            />
          ))}
        </ul>
        {slices.length < SLICES.max && (
          <Button
            type="button"
            variant="secondary"
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => {
              setSaved(false);
              setSlices([
                ...slices,
                { key: nextKey++, label: '', kind: 'NONE', value: '', weight: '1' },
              ]);
            }}
          >
            {t('spinWheel.add')}
          </Button>
        )}
        <TextField
          label={t('spinWheel.codeDays')}
          inputMode="numeric"
          ltr
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
        <TextField
          label={t('spinWheel.minimum')}
          hint={t('spinWheel.minimumHint')}
          inputMode="decimal"
          ltr
          value={minimum}
          onChange={(event) => setMinimum(event.target.value)}
        />
        <CheckField
          label={t('spinWheel.on')}
          hint={t('spinWheel.theme')}
          checked={enabled}
          onChange={setEnabled}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && <Alert tone="success">{t('spinWheel.saved')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={update.isPending}
          icon={<Save aria-hidden className="size-5" />}
        >
          {t('spinWheel.save')}
        </Button>
      </form>
    </Card>
  );
}

/**
 * Spin to win (OS-08, ADR-900): the shop's wheel of offers on its sign-up pop-up, its slices'
 * words, what each gives and how often, and how long and from what order its codes work.
 */
export function SpinWheelPage() {
  const { t } = useLocale();
  const query = useAdminQuery<SpinWheelData>(['spin-wheel'], SpinWheelQuery);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToMarketing />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Disc3 aria-hidden className="size-7 text-secondary" />
        {t('spinWheel.title')}
      </h1>
      <p className="text-secondary">{t('spinWheel.intro')}</p>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : (
        <WheelForm wheel={query.data.spinWheel} />
      )}
    </div>
  );
}
