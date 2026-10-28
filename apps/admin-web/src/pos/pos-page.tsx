import { Calculator, Plus } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  LocationsQuery,
  PosRegisterSaveMutation,
  PosRegistersQuery,
  PosSessionOpenMutation,
} from '../api/operations';
import type {
  PosRegisterSaveData,
  PosRegistersData,
  PosRegisterValue,
  PosSessionPayloadData,
  UserError,
} from '../api/types';
import { gate, permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { SETS_SETTINGS } from '../settings/settings-page';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { SessionPanel } from './session-panel';
import { Till } from './till';

/** Those who sell at the shop's till (POS-01, ADR-872): owners, managers, and roles that may. */
export const SELLS_AT_TILL = gate(['owner', 'manager'], 'write_orders');

/** The register this device sells from, kept in this browser for each shop. */
const REGISTER_KEY = (shopId: string) => `hatti.pos.register.${shopId}`;

function keptRegister(shopId: string): string | null {
  try {
    return window.localStorage.getItem(REGISTER_KEY(shopId));
  } catch {
    return null;
  }
}

function keepRegister(shopId: string, id: string): void {
  try {
    window.localStorage.setItem(REGISTER_KEY(shopId), id);
  } catch {
    // Chosen for this visit alone.
  }
}

interface LocationsData {
  locations: { nodes: { id: string; name: string; isPrimary: boolean }[] };
}

/** A new register: its name, and the location whose shelf it sells from. */
function NewRegister({ onSaved }: { onSaved: (register: PosRegisterValue) => void }) {
  const { t } = useLocale();
  const locations = useAdminQuery<LocationsData>(['locations'], LocationsQuery);
  const save = useAdminMutation<
    PosRegisterSaveData,
    { input: { name: string; locationId: string } }
  >(PosRegisterSaveMutation);
  const [name, setName] = useState('');
  const [location, setLocation] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const nodes = locations.data?.locations.nodes ?? [];
  const chosen = location ?? nodes.find((each) => each.isPrimary)?.id ?? nodes[0]?.id ?? '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { posRegisterSave } = await save.mutateAsync({
        input: { name, locationId: chosen },
      });
      const error: UserError | undefined = posRegisterSave.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else if (posRegisterSave.register) onSaved(posRegisterSave.register);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  if (locations.isPending) return <Loading label={t('state.loading')} />;
  return (
    <Card className="p-4">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <h2 className="text-[length:var(--hatti-type-title-size)] font-semibold">
          {t('pos.newRegister')}
        </h2>
        <TextField
          label={t('pos.registerName')}
          hint={t('pos.registerNameHint')}
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
        <SelectField
          label={t('pos.registerLocation')}
          value={chosen}
          options={nodes.map((each) => ({ value: each.id, label: each.name }))}
          onChange={setLocation}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Button type="submit" className="self-start" busy={save.isPending} disabled={!name.trim()}>
          {t('pos.addRegister')}
        </Button>
      </form>
    </Card>
  );
}

/** Opens the register's session, with the cash in its drawer to start. */
function OpenSession({ register }: { register: PosRegisterValue }) {
  const { t } = useLocale();
  const open = useAdminMutation<
    PosSessionPayloadData,
    { registerId: string; openingFloat: string }
  >(PosSessionOpenMutation);
  const [float, setFloat] = useState('0');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { posSessionOpen } = await open.mutateAsync({
        registerId: register.id,
        openingFloat: float,
      });
      const error = posSessionOpen?.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };
  return (
    <Card className="p-4">
      <form onSubmit={(event) => void submit(event)} className="flex max-w-md flex-col gap-3">
        <h2 className="text-[length:var(--hatti-type-title-size)] font-semibold">
          {t('pos.openTitle', { register: register.name })}
        </h2>
        <p className="text-secondary">{t('pos.openHint')}</p>
        <TextField
          label={t('pos.openingFloat')}
          inputMode="decimal"
          ltr
          value={float}
          onChange={(event) => setFloat(event.target.value)}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Button type="submit" className="self-start" busy={open.isPending}>
          {t('pos.open')}
        </Button>
      </form>
    </Card>
  );
}

/**
 * The shop's till (POS-01, POS-02, POS-07, ADR-872), on a tablet or phone at the counter: the
 * register this device sells from, its cash session opened with a float, and then sales rung up
 * by name or scanner, paid in cash with change, by card on the shop's own terminal, transfer or
 * wallet, each with a receipt to print. Sales made while offline are kept on the device and sent
 * once it is back online. The session closes with the drawer counted: its Z report.
 */
export function PosPage() {
  const { t } = useLocale();
  const shop = useShop();
  const registers = useAdminQuery<PosRegistersData>(['posRegisters'], PosRegistersQuery);
  const [chosen, setChosen] = useState<string | null>(() => keptRegister(shop.id));
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<'sell' | 'session'>('sell');
  const sets = permits(shop, SETS_SETTINGS);

  const title = (
    <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
      <Calculator aria-hidden className="size-6" />
      {t('pos.title')}
    </h1>
  );
  if (registers.isPending) return <Loading label={t('state.loading')} />;
  if (registers.isError) {
    return (
      <ErrorState
        message={errorText(registers.error, t)}
        action={<Button onClick={() => void registers.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const list = registers.data.posRegisters;
  const choose = (id: string) => {
    keepRegister(shop.id, id);
    setChosen(id);
    setAdding(false);
  };
  if (list.length === 0 || adding) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-4">
        {title}
        {sets ? (
          <>
            {list.length === 0 && <p className="text-secondary">{t('pos.noRegisters')}</p>}
            <NewRegister onSaved={(register) => choose(register.id)} />
            {adding && (
              <Button variant="tertiary" className="self-start" onClick={() => setAdding(false)}>
                {t('action.back')}
              </Button>
            )}
          </>
        ) : (
          <EmptyState title={t('pos.noRegistersTitle')} body={t('pos.noRegistersAsk')} />
        )}
      </div>
    );
  }
  const register = list.find((each) => each.id === chosen) ?? list[0]!;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {title}
        <div className="flex flex-wrap items-end gap-2">
          {list.length > 1 && (
            <SelectField
              label={t('pos.register')}
              value={register.id}
              options={list.map((each) => ({ value: each.id, label: each.name }))}
              onChange={choose}
            />
          )}
          {sets && (
            <Button
              variant="secondary"
              icon={<Plus aria-hidden className="size-5" />}
              onClick={() => setAdding(true)}
            >
              {t('pos.addRegister')}
            </Button>
          )}
        </div>
      </div>
      {register.openSessionId === null ? (
        <OpenSession register={register} />
      ) : (
        <>
          <div role="tablist" aria-label={register.name} className="flex gap-2">
            {(['sell', 'session'] as const).map((tab) => (
              <Button
                key={tab}
                role="tab"
                aria-selected={view === tab}
                variant={view === tab ? 'primary' : 'secondary'}
                onClick={() => setView(tab)}
              >
                {t(tab === 'sell' ? 'pos.tabSell' : 'pos.tabSession')}
              </Button>
            ))}
          </div>
          {view === 'sell' ? (
            <Till register={register} sessionId={register.openSessionId} />
          ) : (
            <SessionPanel sessionId={register.openSessionId} onClosed={() => setView('sell')} />
          )}
        </>
      )}
    </div>
  );
}
