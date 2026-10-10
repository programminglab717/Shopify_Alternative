/** An order's link for its customer (COD-02), made again from its page. */
import { Copy, Link2, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { OrderLinkCreateMutation } from '../api/operations';
import type { OrderDetail, OrderLinkCreateData } from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';

/** Those who send customers their order's link: those who speak with them, as drafts' links. */
export const SENDS_LINKS: readonly StaffRole[] = ['owner', 'manager', 'confirmation_agent'];

/**
 * The customer's link to the order, where they confirm or cancel it while it waits for them and
 * follow it after: whether it has one and until when; a new one made, the one before stopping,
 * and shown this once to copy or send on WhatsApp, as Hatti keeps only its digest.
 */
export function CustomerLink({ order, timezone }: { order: OrderDetail; timezone: string }) {
  const { t, locale } = useLocale();
  const create = useAdminMutation<OrderLinkCreateData, { id: string }>(OrderLinkCreateMutation);
  const [asking, setAsking] = useState(false);
  const [made, setMade] = useState<{ url: string; whatsappUrl: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const link = order.customerLink;

  const make = async () => {
    setProblem(null);
    try {
      const { orderLinkCreate: payload } = await create.mutateAsync({ id: order.id });
      const error = payload.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else if (payload.url) {
        setMade({ url: payload.url, whatsappUrl: payload.whatsappUrl });
        setCopied(false);
        setAsking(false);
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <span className="flex items-center gap-2 font-medium">
        <Link2 aria-hidden className="size-5 text-secondary" />
        {t('customerLink.label')}
      </span>
      {made ? (
        <>
          <p>{t('customerLink.made')}</p>
          <input
            readOnly
            dir="ltr"
            value={made.url}
            aria-label={t('customerLink.field')}
            onFocus={(event) => event.target.select()}
            className="min-h-12 rounded-control border border-line bg-canvas px-3 text-start md:min-h-10"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon={<Copy aria-hidden className="size-5" />}
              onClick={() =>
                void navigator.clipboard?.writeText(made.url).then(() => setCopied(true))
              }
            >
              {copied ? t('staff.copied') : t('staff.copy')}
            </Button>
            {made.whatsappUrl && (
              <a
                href={made.whatsappUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium md:min-h-10"
              >
                <MessageCircle aria-hidden className="size-5" />
                {t('staff.sendOnWhatsApp')}
              </a>
            )}
          </div>
        </>
      ) : (
        <p className="text-secondary">
          {!link
            ? t('customerLink.none')
            : link.expiresAt
              ? t('customerLink.until', { date: formatDateTime(link.expiresAt, timezone, locale) })
              : t('customerLink.lasting')}
        </p>
      )}
      {asking ? (
        <div className="flex flex-col gap-2">
          <p>{t('customerLink.replaces')}</p>
          <div className="flex flex-wrap gap-2">
            <Button busy={create.isPending} onClick={() => void make()}>
              {t('customerLink.make')}
            </Button>
            <Button variant="tertiary" onClick={() => setAsking(false)}>
              {t('returns.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="secondary"
          className="self-start"
          busy={create.isPending}
          onClick={() => {
            // A link made here stops the one before: say so first where there is one.
            if (link || made) setAsking(true);
            else void make();
          }}
        >
          {t('customerLink.new')}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}
