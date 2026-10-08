import { Archive, CircleCheck, ImageOff, NotebookPen, Package } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { OrderStage as BadgeColour } from '@hatti/tokens';
import type { MoneyValue, ProductStatus, ProductThumbnail } from '../api/types';
import type { StaffRole } from '../auth/session';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { Badge } from '../ui/badge';

/** Each of a product's statuses as merchants see it: on sale, a draft, or put away. */
export const PRODUCT_STATUSES: Readonly<
  Record<
    ProductStatus,
    { badge: BadgeColour; icon: LucideIcon; label: MessageKey; hint: MessageKey }
  >
> = {
  ACTIVE: {
    badge: 'delivered',
    icon: CircleCheck,
    label: 'product.status.ACTIVE',
    hint: 'product.status.ACTIVE.hint',
  },
  DRAFT: {
    badge: 'needsConfirmation',
    icon: NotebookPen,
    label: 'product.status.DRAFT',
    hint: 'product.status.DRAFT.hint',
  },
  ARCHIVED: {
    badge: 'cancelled',
    icon: Archive,
    label: 'product.status.ARCHIVED',
    hint: 'product.status.ARCHIVED.hint',
  },
};

export function ProductStatusBadge({ status }: { status: ProductStatus }) {
  const { t } = useLocale();
  const shown = PRODUCT_STATUSES[status];
  return <Badge colour={shown.badge} icon={shown.icon} label={t(shown.label)} />;
}

/** The roles that add and change products; every other role sees them (docs/design/02 §6). */
export const EDITS_PRODUCTS: readonly StaffRole[] = ['owner', 'manager'];

/** A product's first image, small, or a placeholder while it has none ready. */
export function ProductThumb({
  media,
  size = 'md',
}: {
  media: ProductThumbnail[];
  size?: 'md' | 'lg';
}) {
  const image = media.find((each) => each.status === 'READY' && each.previewImage);
  const box = size === 'lg' ? 'size-20' : 'size-12';
  if (!image?.previewImage) {
    return (
      <span
        aria-hidden
        className={`${box} flex shrink-0 items-center justify-center rounded-control border border-line bg-canvas text-secondary`}
      >
        {media.length > 0 ? <ImageOff className="size-5" /> : <Package className="size-5" />}
      </span>
    );
  }
  const url = image.previewImage.url;
  const at = (width: number) => `${url}${url.includes('?') ? '&' : '?'}width=${width}`;
  return (
    <img
      src={at(size === 'lg' ? 192 : 96)}
      srcSet={size === 'lg' ? `${at(192)} 1x, ${at(360)} 2x` : `${at(96)} 1x, ${at(192)} 2x`}
      alt=""
      loading="lazy"
      className={`${box} shrink-0 rounded-control border border-line bg-canvas object-cover`}
    />
  );
}

/** A price, or the range of a product's variants' prices. */
export function priceRange(min: MoneyValue, max: MoneyValue): string {
  const low = formatMoney(min.amount, min.currencyCode);
  return Number(min.amount) === Number(max.amount)
    ? low
    : `${low} – ${formatMoney(max.amount, max.currencyCode)}`;
}
