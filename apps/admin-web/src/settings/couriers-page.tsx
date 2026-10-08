import { Archive, Plus, Star, Truck } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  CourierAccountArchiveMutation,
  CourierAccountConnectMutation,
  CourierAccountsQuery,
  CourierAccountUpdateMutation,
} from '../api/operations';
import type {
  CourierAccountDetail,
  CourierAccountPayloadData,
  CourierAccountsData,
  CourierOffered,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { BackToSettings } from './settings-page';

/** Connecting an account with a courier: its credentials as its portal gives them, sealed. */
function ConnectForm({ couriers, onDone }: { couriers: CourierOffered[]; onDone: () => void }) {
  const { t } = useLocale();
  const connect = useAdminMutation<
    { courierAccountConnect: CourierAccountPayloadData },
    { input: Record<string, unknown> }
  >(CourierAccountConnectMutation);
  const [courier, setCourier] = useState(couriers[0]?.courier ?? '');
  const courierField = useId();
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [pickupCode, setPickupCode] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const chosen = couriers.find((each) => each.courier === courier);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    setProblems([]);
    try {
      const { courierAccountConnect } = await connect.mutateAsync({
        input: {
          courier,
          name: name.trim() || null,
          credentials: chosen.credentials.map((field) => ({
            key: field.key,
            value: (values[field.key] ?? '').trim(),
          })),
          ...(chosen.pickupCode && pickupCode.trim() && { pickupCode: pickupCode.trim() }),
        },
      });
      if (courierAccountConnect.userErrors.length > 0) {
        setProblems(courierAccountConnect.userErrors.map((error) => problemText(error, t)));
      } else onDone();
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <h2 className="font-semibold">{t('couriers.connect')}</h2>
        <div className="flex flex-col gap-1">
          <label htmlFor={courierField} className="font-medium">
            {t('couriers.courier')}
          </label>
          <select
            id={courierField}
            value={courier}
            onChange={(event) => {
              setCourier(event.target.value);
              setValues({});
            }}
            className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
          >
            {couriers.map((each) => (
              <option key={each.courier} value={each.courier}>
                {each.name}
              </option>
            ))}
          </select>
        </div>
        {chosen?.test && <Alert tone="info">{t('couriers.testCourier')}</Alert>}
        {chosen?.credentials.map((field) => (
          <TextField
            key={`${courier}-${field.key}`}
            label={field.label}
            type="password"
            autoComplete="off"
            ltr
            required
            value={values[field.key] ?? ''}
            onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
          />
        ))}
        {chosen?.pickupCode && (
          <TextField
            label={chosen.pickupCode}
            hint={t('couriers.pickupCodeHint')}
            ltr
            value={pickupCode}
            onChange={(event) => setPickupCode(event.target.value)}
          />
        )}
        <TextField
          label={t('couriers.name')}
          hint={t('couriers.nameHint')}
          dir="auto"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('couriers.sealed')}
        </p>
        {problems.length > 0 && (
          <Alert tone="danger">
            <ul className="flex flex-col gap-1">
              {problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}
        <Button type="submit" busy={connect.isPending} className="self-start">
          {t('couriers.connectSubmit')}
        </Button>
      </form>
    </Card>
  );
}

function AccountRow({ account }: { account: CourierAccountDetail }) {
  const { t } = useLocale();
  const update = useAdminMutation<
    { courierAccountUpdate: CourierAccountPayloadData },
    { id: string; input: { isDefault: true } }
  >(CourierAccountUpdateMutation);
  const archive = useAdminMutation<
    { courierAccountArchive: CourierAccountPayloadData },
    { id: string }
  >(CourierAccountArchiveMutation);
  const [archiving, setArchiving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (action: () => Promise<CourierAccountPayloadData>) => {
    setProblem(null);
    try {
      const payload = await action();
      if (payload.userErrors[0]) setProblem(problemText(payload.userErrors[0], t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Truck aria-hidden className="size-5 text-secondary" />
        <span className="font-medium" dir="auto">
          {account.name}
        </span>
        {account.name !== account.courierName && (
          <span className="text-secondary">{account.courierName}</span>
        )}
        {account.isDefault && (
          <span className="rounded-full bg-canvas px-2 text-[length:var(--hatti-type-body-sm-size)] font-medium text-primary">
            {t('couriers.default')}
          </span>
        )}
        <span className="flex-1" />
        <span className="num text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('couriers.credentialsHint', { hint: account.credentialsHint })}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {!account.isDefault && (
          <Button
            variant="tertiary"
            icon={<Star aria-hidden className="size-5" />}
            busy={update.isPending}
            onClick={() =>
              void run(
                async () =>
                  (await update.mutateAsync({ id: account.id, input: { isDefault: true } }))
                    .courierAccountUpdate,
              )
            }
          >
            {t('couriers.makeDefault')}
          </Button>
        )}
        {archiving ? (
          <>
            <span className="self-center">{t('couriers.archiveSure')}</span>
            <Button
              variant="destructive"
              busy={archive.isPending}
              onClick={() =>
                void run(
                  async () => (await archive.mutateAsync({ id: account.id })).courierAccountArchive,
                )
              }
            >
              {t('couriers.archiveYes')}
            </Button>
            <Button variant="tertiary" onClick={() => setArchiving(false)}>
              {t('action.back')}
            </Button>
          </>
        ) : (
          <Button
            variant="danger"
            icon={<Archive aria-hidden className="size-5" />}
            onClick={() => setArchiving(true)}
          >
            {t('couriers.archive')}
          </Button>
        )}
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/**
 * The shop's courier accounts (SHP-01, ADR-149): connected with the credentials each courier's
 * portal gives, kept sealed and never shown again but their last characters; one the default
 * that bookings use; archived when done with.
 */
export function CouriersPage() {
  const { t } = useLocale();
  const query = useAdminQuery<CourierAccountsData>(['courierAccounts'], CourierAccountsQuery);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { couriers, courierAccounts: accounts } = query.data;
  const showForm = connecting || accounts.length === 0;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.couriers')}
      </h1>
      {connected && <Alert tone="success">{t('couriers.connected')}</Alert>}
      {accounts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Truck aria-hidden className="size-8 text-secondary" />}
            title={t('couriers.none')}
            body={t('couriers.noneBody')}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {accounts.map((account) => (
              <AccountRow key={account.id} account={account} />
            ))}
          </ul>
        </Card>
      )}
      {showForm ? (
        <ConnectForm
          couriers={couriers}
          onDone={() => {
            setConnecting(false);
            setConnected(true);
          }}
        />
      ) : (
        <Button
          variant="secondary"
          className="self-start"
          icon={<Plus aria-hidden className="size-5" />}
          onClick={() => {
            setConnecting(true);
            setConnected(false);
          }}
        >
          {t('couriers.connectAnother')}
        </Button>
      )}
    </div>
  );
}
