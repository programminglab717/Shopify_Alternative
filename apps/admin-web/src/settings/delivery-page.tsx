import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { DeliverySettingsQuery, DeliverySettingsUpdateMutation } from '../api/operations';
import type {
  DeliveryDaysValue,
  DeliverySettingsData,
  DeliverySettingsValue,
  SettingsPayloadData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, priceText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import {
  amountInput,
  Pair,
  parseList,
  parseWhole,
  Problems,
  settingProblem,
} from './settings-form';
import { BackToSettings } from './settings-page';

/** The most zones a shop has (the core's DELIVERY_LIMITS). */
const MOST_ZONES = 20;

interface DaysState {
  min: string;
  max: string;
}

interface ZoneState {
  key: number;
  name: string;
  charge: string;
  cities: string;
  days: DaysState;
}

interface DeliveryState {
  charge: string;
  freeAbove: string;
  days: DaysState;
  zones: ZoneState[];
}

function daysState(days: DeliveryDaysValue | null): DaysState {
  return { min: days ? String(days.min) : '', max: days ? String(days.max) : '' };
}

function stateOf(settings: DeliverySettingsValue): DeliveryState {
  return {
    charge: Number(settings.charge.amount) === 0 ? '' : priceText(settings.charge.amount),
    freeAbove: priceText(settings.freeAbove?.amount),
    days: daysState(settings.days),
    zones: settings.zones.map((zone, key) => ({
      key,
      name: zone.name,
      charge: priceText(zone.charge.amount),
      cities: zone.cities.join(', '),
      days: daysState(zone.days),
    })),
  };
}

/** Days as the API takes them: null when both are blank; a problem when one is not a number. */
function daysInput(days: DaysState): DeliveryDaysValue | null | 'bad' {
  if (!days.min.trim() && !days.max.trim()) return null;
  const min = parseWhole(days.min);
  const max = parseWhole(days.max || days.min);
  if (min === null || max === null || Number.isNaN(min) || Number.isNaN(max)) return 'bad';
  return { min, max };
}

const LABELS: Partial<Record<string, MessageKey>> = {
  charge: 'delivery.charge',
  freeAbove: 'delivery.freeAbove',
  days: 'delivery.days',
  name: 'delivery.zoneName',
  cities: 'delivery.zoneCities',
};

/** "Zone 2" for a problem with the second zone. */
function zoneOf(t: Translate) {
  return (field: string[]) => {
    const at = field.indexOf('zones');
    const index = Number(field[at + 1]);
    return at >= 0 && Number.isInteger(index) ? t('delivery.zoneNumber', { n: index + 1 }) : null;
  };
}

function DaysFields({
  days,
  hint,
  onChange,
}: {
  days: DaysState;
  hint: string;
  onChange: (days: DaysState) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col gap-1">
      <Pair>
        <TextField
          label={t('delivery.daysMin')}
          inputMode="numeric"
          ltr
          value={days.min}
          onChange={(event) => onChange({ ...days, min: event.target.value })}
        />
        <TextField
          label={t('delivery.daysMax')}
          inputMode="numeric"
          ltr
          value={days.max}
          onChange={(event) => onChange({ ...days, max: event.target.value })}
        />
      </Pair>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">{hint}</p>
    </div>
  );
}

function ZoneFields({
  zone,
  number,
  onChange,
  onRemove,
}: {
  zone: ZoneState;
  number: number;
  onChange: (zone: ZoneState) => void;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  return (
    <li className="flex flex-col gap-4 rounded-control border border-line p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{t('delivery.zoneNumber', { n: number })}</h3>
        <Button
          variant="danger"
          icon={<Trash2 aria-hidden className="size-5" />}
          onClick={onRemove}
        >
          {t('delivery.removeZone')}
        </Button>
      </div>
      <Pair>
        <TextField
          label={t('delivery.zoneName')}
          hint={t('delivery.zoneNameHint')}
          required
          dir="auto"
          value={zone.name}
          onChange={(event) => onChange({ ...zone, name: event.target.value })}
        />
        <TextField
          label={t('delivery.zoneCharge')}
          required
          inputMode="decimal"
          ltr
          value={zone.charge}
          onChange={(event) => onChange({ ...zone, charge: event.target.value })}
        />
      </Pair>
      <TextField
        label={t('delivery.zoneCities')}
        hint={t('delivery.zoneCitiesHint')}
        required
        dir="auto"
        value={zone.cities}
        onChange={(event) => onChange({ ...zone, cities: event.target.value })}
      />
      <DaysFields
        days={zone.days}
        hint={t('delivery.zoneDaysHint')}
        onChange={(days) => onChange({ ...zone, days })}
      />
    </li>
  );
}

function DeliveryForm({ settings }: { settings: DeliverySettingsValue }) {
  const { t } = useLocale();
  const save = useAdminMutation<
    { deliverySettingsUpdate: SettingsPayloadData },
    { input: Record<string, unknown> }
  >(DeliverySettingsUpdateMutation);
  const [state, setState] = useState(() => stateOf(settings));
  const [nextKey, setNextKey] = useState(settings.zones.length);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const days = daysInput(state.days);
    const zones = state.zones.map((zone) => ({ zone, days: daysInput(zone.days) }));
    const badDays = [
      ...(days === 'bad' ? [`${t('delivery.days')}: ${t('delivery.badDays')}`] : []),
      ...zones.flatMap(({ days: zoneDays }, index) =>
        zoneDays === 'bad'
          ? [`${t('delivery.zoneNumber', { n: index + 1 })}: ${t('delivery.badDays')}`]
          : [],
      ),
    ];
    if (badDays.length > 0) {
      setProblems(badDays);
      return;
    }
    setProblems([]);
    try {
      const { deliverySettingsUpdate } = await save.mutateAsync({
        input: {
          charge: amountInput(state.charge),
          freeAbove: amountInput(state.freeAbove),
          days,
          zones: zones.map(({ zone, days: zoneDays }) => ({
            name: zone.name.trim(),
            charge: zone.charge.trim(),
            cities: parseList(zone.cities),
            days: zoneDays,
          })),
        },
      });
      if (deliverySettingsUpdate.userErrors.length > 0) {
        setProblems(
          deliverySettingsUpdate.userErrors.map((error) =>
            settingProblem(error, t, LABELS, zoneOf(t)),
          ),
        );
      } else setSaved(true);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  const setZone = (key: number, zone: ZoneState) =>
    setState({ ...state, zones: state.zones.map((each) => (each.key === key ? zone : each)) });

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection title={t('delivery.everywhere')} hint={t('delivery.everywhereHint')}>
        <Pair>
          <TextField
            label={t('delivery.charge')}
            hint={t('delivery.chargeHint')}
            inputMode="decimal"
            ltr
            value={state.charge}
            onChange={(event) => setState({ ...state, charge: event.target.value })}
          />
          <TextField
            label={t('delivery.freeAbove')}
            hint={t('delivery.freeAboveHint')}
            inputMode="decimal"
            ltr
            value={state.freeAbove}
            onChange={(event) => setState({ ...state, freeAbove: event.target.value })}
          />
        </Pair>
        <DaysFields
          days={state.days}
          hint={t('delivery.daysHint')}
          onChange={(days) => setState({ ...state, days })}
        />
      </FormSection>
      <FormSection title={t('delivery.zones')} hint={t('delivery.zonesHint')}>
        {state.zones.length > 0 && (
          <ul className="flex flex-col gap-4">
            {state.zones.map((zone, index) => (
              <ZoneFields
                key={zone.key}
                zone={zone}
                number={index + 1}
                onChange={(next) => setZone(zone.key, next)}
                onRemove={() =>
                  setState({ ...state, zones: state.zones.filter((each) => each !== zone) })
                }
              />
            ))}
          </ul>
        )}
        {state.zones.length < MOST_ZONES && (
          <Button
            variant="secondary"
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => {
              setState({
                ...state,
                zones: [
                  ...state.zones,
                  { key: nextKey, name: '', charge: '', cities: '', days: { min: '', max: '' } },
                ],
              });
              setNextKey(nextKey + 1);
            }}
          >
            {t('delivery.addZone')}
          </Button>
        )}
      </FormSection>
      <Problems problems={problems} />
      {saved && <Alert tone="success">{t('settings.saved')}</Alert>}
      <Button type="submit" busy={save.isPending} className="self-start">
        {t('product.save')}
      </Button>
    </form>
  );
}

/**
 * What the shop charges to deliver an order (CHK-22, ADR-043): one charge for everywhere, zones
 * of cities with their own, free above a subtotal, and how many working days delivery takes,
 * which the storefront and checkout tell shoppers.
 */
export function DeliveryPage() {
  const { t } = useLocale();
  const query = useAdminQuery<DeliverySettingsData>(['deliverySettings'], DeliverySettingsQuery);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.delivery')}
      </h1>
      <DeliveryForm settings={query.data.deliverySettings} />
    </div>
  );
}
