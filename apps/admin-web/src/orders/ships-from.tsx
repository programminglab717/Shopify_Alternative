import { useState } from 'react';
import { LocationsQuery, OrderLocationChangeMutation } from '../api/operations';
import type { LocationsData, OrderDetail, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Loading } from '../ui/feedback';
import { WORKS_PARCELS } from './parcels';

type Moved = { orderLocationChange: { userErrors: UserError[] } };

/** The shop's other locations, one chosen, and the order's stock moved there. */
function MoveForm({ order, onDone }: { order: OrderDetail; onDone: () => void }) {
  const { t } = useLocale();
  const places = useAdminQuery<LocationsData>(['locations'], LocationsQuery);
  const move = useAdminMutation<Moved, { id: string; locationId: string }>(
    OrderLocationChangeMutation,
  );
  const [chosen, setChosen] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  if (places.isPending) return <Loading label={t('state.loading')} />;
  if (places.isError) return <Alert tone="danger">{errorText(places.error, t)}</Alert>;
  const others = places.data.locations.nodes.filter((each) => each.id !== order.location.id);
  const locationId = chosen || others[0]?.id || '';

  const onMove = async () => {
    setProblem(null);
    try {
      const { orderLocationChange } = await move.mutateAsync({ id: order.id, locationId });
      if (orderLocationChange.userErrors.length > 0) {
        setProblem(orderLocationChange.userErrors.map((error) => error.message).join(' '));
      } else onDone();
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-secondary">{t('shipsFrom.hint')}</p>
      <SelectField
        label={t('shipsFrom.location')}
        value={locationId}
        options={others.map((each) => ({ value: each.id, label: each.name }))}
        onChange={setChosen}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button busy={move.isPending} disabled={!locationId} onClick={() => void onMove()}>
          {t('shipsFrom.save')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Where the order ships from and its stock is set aside (INV-10): moved to another location by
 * those who work parcels, until it is packed or anything has shipped.
 */
export function ShipsFrom({ order }: { order: OrderDetail }) {
  const { t } = useLocale();
  const { role } = useShop();
  const [moving, setMoving] = useState(false);
  const movable =
    WORKS_PARCELS.includes(role) &&
    order.status === 'OPEN' &&
    !order.overPlanLimit &&
    order.stage !== 'TO_BOOK' &&
    order.fulfillments.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium" dir="auto">
        {order.location.name}
      </p>
      {moving ? (
        <MoveForm order={order} onDone={() => setMoving(false)} />
      ) : (
        movable && (
          <Button variant="secondary" className="self-start" onClick={() => setMoving(true)}>
            {t('shipsFrom.change')}
          </Button>
        )
      )}
    </div>
  );
}
