import { Link2 } from 'lucide-react';
import { useState } from 'react';
import { PaymentLinksQuery } from '../api/operations';
import type { PaymentLinksData, PaymentLinkValue } from '../api/types';
import { gate, permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card } from '../ui/feedback';
import { TextField } from '../ui/field';

/** Who puts the shop's payment links in answers: those who answer and may read orders. */
export const PUTS_PAYMENT_LINKS = gate(['owner', 'manager', 'confirmation_agent'], 'read_orders');

/** What a payment link sells, as an answer says it: "Lawn suit × 2, Dupatta". */
function itemsText(link: PaymentLinkValue): string {
  return link.items
    .map((item) => `${item.title ?? ''}${item.quantity > 1 ? ` × ${item.quantity}` : ''}`)
    .filter((each) => each.trim())
    .join(', ');
}

/**
 * A payment link put in an answer (MSG-08, ADR-767): its title, what it sells and its address,
 * where the customer pays online, or on delivery where the link allows. Only links still taking
 * orders are offered.
 */
export function PaymentLinkPicker({ onPick }: { onPick: (text: string) => void }) {
  const { t } = useLocale();
  const shop = useShop();
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState('');
  const links = useAdminQuery<PaymentLinksData>(['paymentLinks'], PaymentLinksQuery, undefined, {
    enabled: open,
  });

  if (!permits(shop, PUTS_PAYMENT_LINKS)) return null;
  if (!open) {
    return (
      <Button
        variant="tertiary"
        icon={<Link2 aria-hidden className="size-5" />}
        onClick={() => setOpen(true)}
      >
        {t('inbox.paymentLink.pick')}
      </Button>
    );
  }
  const needle = words.trim().toLocaleLowerCase();
  const taking = (links.data?.paymentLinks ?? []).filter(
    (link) =>
      link.open &&
      (!needle || `${link.title}\n${itemsText(link)}`.toLocaleLowerCase().includes(needle)),
  );
  return (
    <Card className="flex w-full flex-col gap-2 p-3">
      <TextField
        label={t('inbox.paymentLink.find')}
        dir="auto"
        value={words}
        onChange={(event) => setWords(event.target.value)}
      />
      {links.isPending ? (
        <p className="text-secondary">{t('state.loading')}</p>
      ) : links.isError ? (
        <p className="text-danger">{errorText(links.error, t)}</p>
      ) : taking.length === 0 ? (
        <p className="text-secondary">{t('inbox.paymentLink.none')}</p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {taking.map((link) => (
            <li key={link.id}>
              <button
                type="button"
                onClick={() => {
                  onPick([link.title, itemsText(link), link.url].filter(Boolean).join('\n'));
                  setOpen(false);
                  setWords('');
                }}
                className="flex min-h-10 w-full flex-col items-start rounded-control px-2 py-1 text-start hover:bg-canvas"
              >
                <span className="font-medium" dir="auto">
                  {link.title}
                </span>
                <span className="line-clamp-1 text-secondary" dir="auto">
                  {itemsText(link)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button variant="tertiary" onClick={() => setOpen(false)}>
          {t('returns.cancel')}
        </Button>
      </div>
    </Card>
  );
}
