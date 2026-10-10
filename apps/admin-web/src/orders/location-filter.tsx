import { useId, useState } from 'react';
import { LocationsQuery } from '../api/operations';
import type { LocationsData } from '../api/types';
import { useLocale } from '../i18n/locale';
import { useAdminQuery, useShop } from '../shell/shop-context';

/** "All": every location's orders, chosen as such. */
const ALL = '';

const storageKey = (shopId: string) => `hatti.ordersLocation.${shopId}`;

/** The location last chosen in this browser; browser storage may be missing or blocked. */
function kept(shopId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(shopId));
  } catch {
    return null;
  }
}

function keep(shopId: string, locationId: string): void {
  try {
    window.localStorage.setItem(storageKey(shopId), locationId);
  } catch {
    // Kept for this visit alone.
  }
}

/**
 * The location whose orders the list shows (INV-10, ADR-356): the one in the link, else the one
 * chosen last in this browser, so that a branch's packers see their own each day; every location's
 * where the shop has one, or the one kept is gone.
 */
export function useOrdersLocation(fromLink: string | undefined) {
  const shop = useShop();
  const places = useAdminQuery<LocationsData>(['locations'], LocationsQuery);
  const [chosen, setChosen] = useState<string | null>(() => kept(shop.id));
  const locations = places.data?.locations.nodes ?? [];
  const wanted = fromLink ?? chosen ?? ALL;
  const location =
    locations.length > 1 && locations.some((each) => each.id === wanted) ? wanted : undefined;
  return {
    /** False until the shop's locations are known, so the list is read once, for the right one. */
    ready: !places.isPending,
    locations: locations.length > 1 ? locations : [],
    location,
    choose: (locationId: string) => {
      keep(shop.id, locationId);
      setChosen(locationId);
    },
  };
}

/** Orders by where they ship from, for a shop with more than one location. */
export function LocationFilter({
  locations,
  location,
  onChoose,
}: {
  locations: readonly { id: string; name: string }[];
  location: string | undefined;
  onChoose: (locationId: string | undefined) => void;
}) {
  const { t } = useLocale();
  const id = useId();
  if (locations.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="font-medium">
        {t('shipsFrom.title')}
      </label>
      <select
        id={id}
        value={location ?? ALL}
        onChange={(event) => onChoose(event.target.value || undefined)}
        className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
      >
        <option value={ALL}>{t('shipsFrom.all')}</option>
        {locations.map((each) => (
          <option key={each.id} value={each.id}>
            {each.name}
          </option>
        ))}
      </select>
    </div>
  );
}
