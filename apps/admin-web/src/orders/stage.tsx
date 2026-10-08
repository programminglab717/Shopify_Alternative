import {
  Ban,
  CircleCheck,
  CircleHelp,
  Clock,
  Package,
  PackageCheck,
  PhoneCall,
  RotateCcw,
  SearchX,
  ShieldAlert,
  Truck,
  Undo2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { OrderStage as TokenStage } from '@hatti/tokens';
import type { OrderStage } from '../api/types';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';

/**
 * Each of the API's order stages as merchants see it (docs/design/01 §4.1): the design system's
 * badge colours, an icon and words, never colour alone.
 */
export const STAGES: Readonly<
  Record<OrderStage, { badge: TokenStage; icon: LucideIcon; label: MessageKey }>
> = {
  NEEDS_CONFIRMATION: {
    badge: 'needsConfirmation',
    icon: PhoneCall,
    label: 'stage.NEEDS_CONFIRMATION',
  },
  NEEDS_REVIEW: { badge: 'deliveryIssue', icon: ShieldAlert, label: 'stage.NEEDS_REVIEW' },
  AWAITING_PAYMENT: { badge: 'needsConfirmation', icon: Clock, label: 'stage.AWAITING_PAYMENT' },
  TO_PACK: { badge: 'confirmed', icon: Package, label: 'stage.TO_PACK' },
  TO_BOOK: { badge: 'packed', icon: PackageCheck, label: 'stage.TO_BOOK' },
  PARTIALLY_FULFILLED: { badge: 'inTransit', icon: Truck, label: 'stage.PARTIALLY_FULFILLED' },
  IN_TRANSIT: { badge: 'inTransit', icon: Truck, label: 'stage.IN_TRANSIT' },
  DELIVERED: { badge: 'delivered', icon: CircleCheck, label: 'stage.DELIVERED' },
  COMPLETED: { badge: 'delivered', icon: CircleCheck, label: 'stage.COMPLETED' },
  RETURNING: { badge: 'deliveryIssue', icon: Undo2, label: 'stage.RETURNING' },
  RETURNED: { badge: 'returned', icon: RotateCcw, label: 'stage.RETURNED' },
  LOST: { badge: 'returned', icon: SearchX, label: 'stage.LOST' },
  CANCELLED: { badge: 'cancelled', icon: Ban, label: 'stage.CANCELLED' },
};

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** An order's stage as a pill: the stage's colours from the tokens, its icon and its name. */
export function StageBadge({ stage }: { stage: OrderStage }) {
  const { t } = useLocale();
  const shown = STAGES[stage] ?? { badge: 'cancelled', icon: CircleHelp, label: 'stage.UNKNOWN' };
  const badge = kebab(shown.badge);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[length:var(--hatti-type-body-sm-size)] font-medium whitespace-nowrap"
      style={{
        color: `var(--hatti-badge-${badge}-text)`,
        backgroundColor: `var(--hatti-badge-${badge}-bg)`,
      }}
    >
      <shown.icon aria-hidden className="size-4" />
      {t(shown.label)}
    </span>
  );
}
