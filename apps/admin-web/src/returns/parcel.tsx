import { Link } from '@tanstack/react-router';
import type { StaffRole } from '../auth/session';
import { useShop } from '../shell/shop-context';

/** The roles that see parcels coming back: those who check them in, and those who claim. */
export const READS_RETURNS: readonly StaffRole[] = ['owner', 'manager', 'packer', 'accountant'];

/** Those who check parcels in and mark them lost, as the core lets them (`write_orders`). */
export const CHECKS_IN: readonly StaffRole[] = ['owner', 'manager', 'packer'];

/** Those who claim from couriers and settle the claims, as the core lets them (ADR-093). */
export const CLAIMS: readonly StaffRole[] = ['owner', 'manager', 'accountant'];

/** Days on the way back from which a courier is slow, worth a call. */
export const SLOW_RETURN_DAYS = 14;

/** The section's tabs: coming back, lost, and the claims on couriers. */
export const RETURNS_TABS = ['back', 'lost', 'claims'] as const;
export type ReturnsTab = (typeof RETURNS_TABS)[number];

/** A parcel's courier and tracking number, as its label has them. */
export function trackingText(info: { company: string | null; number: string | null }): string {
  return [info.company, info.number].filter(Boolean).join(' · ');
}

/** A parcel's order, linked, and how its courier knows it. */
export function ParcelTitle({
  orderId,
  orderName,
  tracking,
}: {
  orderId: string;
  orderName: string;
  tracking: { company: string | null; number: string | null };
}) {
  const shopId = useShop().id;
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <Link
        to="/$shopId/orders/$orderId"
        params={{ shopId, orderId }}
        className="num self-start font-medium underline"
      >
        {orderName}
      </Link>
      <span className="num text-secondary text-[length:var(--hatti-type-body-sm-size)]" dir="ltr">
        {trackingText(tracking)}
      </span>
    </span>
  );
}
