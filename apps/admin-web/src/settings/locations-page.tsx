import { Pencil, Plus, Power, PowerOff, Save, Trash2, Warehouse } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  LocationActivateMutation,
  LocationAddMutation,
  LocationDeactivateMutation,
  LocationDeleteMutation,
  LocationEditMutation,
  ShopLocationsQuery,
} from '../api/operations';
import type { LocationPayloadData, ShopLocation, ShopLocationsData, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatPhone } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CheckField, Pair, Problems, settingProblem } from './settings-form';
import { BackToSettings } from './settings-page';

const LABELS: Partial<Record<string, MessageKey>> = {
  name: 'locations.name',
  address1: 'locations.address1',
  address2: 'locations.address2',
  city: 'locations.city',
  province: 'locations.province',
  zip: 'locations.zip',
  phone: 'locations.phone',
};

interface Draft {
  name: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  phone: string;
  fulfils: boolean;
}

const EMPTY: Draft = {
  name: '',
  address1: '',
  address2: '',
  city: '',
  province: '',
  zip: '',
  phone: '',
  fulfils: true,
};

function draftOf(location: ShopLocation): Draft {
  const address = location.address;
  return {
    name: location.name,
    address1: address.address1 ?? '',
    address2: address.address2 ?? '',
    city: address.city ?? '',
    province: address.province ?? '',
    zip: address.zip ?? '',
    phone: address.phone ? formatPhone(address.phone) : '',
    fulfils: location.fulfillsOnlineOrders,
  };
}

/** The location as the core takes it: blank parts of its address as none. */
function inputOf(draft: Draft) {
  const part = (text: string) => text.trim() || null;
  return {
    name: draft.name.trim(),
    fulfillsOnlineOrders: draft.fulfils,
    address: {
      address1: part(draft.address1),
      address2: part(draft.address2),
      city: part(draft.city),
      province: part(draft.province),
      zip: part(draft.zip),
      phone: part(draft.phone),
    },
  };
}

/** A location's name, address, courier pickup number and whether it fulfils online orders. */
function LocationForm({
  initial,
  submit,
  busy,
  label,
  onCancel,
}: {
  initial: Draft;
  submit: (input: ReturnType<typeof inputOf>) => Promise<UserError[] | null>;
  busy: boolean;
  label: string;
  onCancel?: () => void;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(initial);
  const [problems, setProblems] = useState<string[]>([]);
  const set = (change: Partial<Draft>) => setDraft((all) => ({ ...all, ...change }));
  const field = (key: keyof Omit<Draft, 'fulfils'>, extra: object = {}) => ({
    label: t(LABELS[key]!),
    value: draft[key],
    onChange: (event: { target: { value: string } }) => set({ [key]: event.target.value }),
    ...extra,
  });

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblems([]);
    try {
      const errors = await submit(inputOf(draft));
      if (errors && errors.length > 0) {
        setProblems(errors.map((error) => settingProblem(error, t, LABELS, () => null)));
      } else if (!onCancel) setDraft(EMPTY);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <TextField {...field('name')} dir="auto" required />
      <TextField {...field('address1')} dir="auto" />
      <TextField {...field('address2')} dir="auto" />
      <Pair>
        <TextField {...field('city')} dir="auto" />
        <TextField {...field('province', { hint: t('locations.provinceHint') })} dir="auto" />
      </Pair>
      <Pair>
        <TextField {...field('zip')} inputMode="numeric" ltr />
        <TextField
          {...field('phone', { hint: t('locations.phoneHint') })}
          type="tel"
          inputMode="tel"
          placeholder="0300 1234567"
          ltr
        />
      </Pair>
      <CheckField
        label={t('locations.fulfils')}
        hint={t('locations.fulfilsHint')}
        checked={draft.fulfils}
        onChange={(fulfils) => set({ fulfils })}
      />
      <Problems problems={problems} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          busy={busy}
          icon={
            onCancel ? (
              <Save aria-hidden className="size-5" />
            ) : (
              <Plus aria-hidden className="size-5" />
            )
          }
        >
          {label}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            {t('locations.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

/** One location: what it is, and changed, taken out of use, put back or deleted. */
function LocationRow({ location }: { location: ShopLocation }) {
  const { t } = useLocale();
  const edit = useAdminMutation<LocationPayloadData, { id: string; input: object }>(
    LocationEditMutation,
  );
  const deactivate = useAdminMutation<LocationPayloadData, { locationId: string }>(
    LocationDeactivateMutation,
  );
  const activate = useAdminMutation<LocationPayloadData, { locationId: string }>(
    LocationActivateMutation,
  );
  const remove = useAdminMutation<
    { locationDelete: { deletedLocationId: string | null; userErrors: UserError[] } },
    { locationId: string }
  >(LocationDeleteMutation);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const act = async (run: () => Promise<UserError[]>) => {
    setProblem(null);
    try {
      const error = (await run())[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium" dir="auto">
          {location.name}
        </span>
        {location.isPrimary && (
          <span className="rounded-full bg-canvas px-2 text-[length:var(--hatti-type-body-sm-size)] font-medium">
            {t('locations.primary')}
          </span>
        )}
        {!location.isActive && (
          <span className="rounded-full bg-canvas px-2 text-[length:var(--hatti-type-body-sm-size)] font-medium text-warning">
            {t('locations.inactive')}
          </span>
        )}
      </span>
      {location.address.formatted.length > 0 && (
        <address className="not-italic text-secondary" dir="auto">
          {location.address.formatted.join(', ')}
        </address>
      )}
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t(location.fulfillsOnlineOrders ? 'locations.fulfilsYes' : 'locations.fulfilsNo')}
      </span>
      {editing ? (
        <LocationForm
          initial={draftOf(location)}
          busy={edit.isPending}
          label={t('locations.save')}
          onCancel={() => setEditing(false)}
          submit={async (input) => {
            const { locationEdit } = await edit.mutateAsync({ id: location.id, input });
            const errors = locationEdit?.userErrors ?? [];
            if (errors.length === 0) setEditing(false);
            return errors;
          }}
        />
      ) : asking ? (
        <Alert tone="warning">
          <p>{t('locations.deleteAsk', { name: location.name })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={remove.isPending}
              onClick={() =>
                void act(async () => {
                  const { locationDelete } = await remove.mutateAsync({ locationId: location.id });
                  if (locationDelete.userErrors.length > 0) setAsking(false);
                  return locationDelete.userErrors;
                })
              }
            >
              {t('locations.deleteSure')}
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {t('locations.keep')}
            </Button>
          </div>
        </Alert>
      ) : (
        <span className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<Pencil aria-hidden className="size-5" />}
            aria-label={t('locations.editOf', { name: location.name })}
            onClick={() => setEditing(true)}
          >
            {t('locations.edit')}
          </Button>
          {!location.isPrimary &&
            (location.isActive ? (
              <Button
                variant="tertiary"
                busy={deactivate.isPending}
                icon={<PowerOff aria-hidden className="size-5" />}
                onClick={() =>
                  void act(
                    async () =>
                      (await deactivate.mutateAsync({ locationId: location.id }))
                        .locationDeactivate!.userErrors,
                  )
                }
              >
                {t('locations.deactivate')}
              </Button>
            ) : (
              <Button
                variant="tertiary"
                busy={activate.isPending}
                icon={<Power aria-hidden className="size-5" />}
                onClick={() =>
                  void act(
                    async () =>
                      (await activate.mutateAsync({ locationId: location.id })).locationActivate!
                        .userErrors,
                  )
                }
              >
                {t('locations.activate')}
              </Button>
            ))}
          {!location.isPrimary && (
            <Button
              variant="danger"
              icon={<Trash2 aria-hidden className="size-5" />}
              aria-label={t('locations.deleteOf', { name: location.name })}
              onClick={() => setAsking(true)}
            />
          )}
        </span>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/**
 * The shop's locations (INV-01): its warehouses and shops, with their addresses and the number
 * couriers call for pickups, which of them fulfil online orders; added, changed, taken out of use
 * once they hold no stock and wait on no orders, put back, and deleted if they never held stock.
 * The primary one stays.
 */
export function LocationsPage() {
  const { t } = useLocale();
  const query = useAdminQuery<ShopLocationsData>(['shopLocations'], ShopLocationsQuery);
  const add = useAdminMutation<LocationPayloadData, { input: object }>(LocationAddMutation);
  const [added, setAdded] = useState<string | null>(null);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Warehouse aria-hidden className="size-7 text-secondary" />
        {t('locations.title')}
      </h1>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {query.data.locations.nodes.map((location) => (
              <LocationRow key={location.id} location={location} />
            ))}
          </ul>
        </Card>
      )}
      <FormSection title={t('locations.add')} hint={t('locations.addHint')}>
        <LocationForm
          initial={EMPTY}
          busy={add.isPending}
          label={t('locations.addSubmit')}
          submit={async (input) => {
            setAdded(null);
            const { locationAdd } = await add.mutateAsync({ input });
            const errors = locationAdd?.userErrors ?? [];
            if (errors.length === 0) setAdded(locationAdd!.location!.name);
            return errors;
          }}
        />
        {added && <Alert tone="success">{t('locations.added', { name: added })}</Alert>}
      </FormSection>
    </div>
  );
}
