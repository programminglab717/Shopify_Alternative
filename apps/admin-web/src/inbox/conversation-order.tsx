import { Link } from '@tanstack/react-router';
import { FilePlus2, Send } from 'lucide-react';
import { useState } from 'react';
import { ConversationDraftLinkSendMutation, DraftOrdersQuery } from '../api/operations';
import type { ConversationUpdatePayload, ConversationValue, DraftOrdersData } from '../api/types';
import { permits } from '../auth/permissions';
import { TAKES_DRAFTS } from '../drafts/drafts-page';
import { errorText, userErrorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';

/** How many of the shop's open drafts the card offers, the latest first. */
const OFFERED = 5;

/**
 * An order from the conversation (MSG-08, ADR-765): one of the shop's open drafts sent as an
 * answer, its link where the customer adds their address and confirms. Offered to those who take
 * drafts, while WhatsApp lets the shop answer.
 */
export function ConversationOrder({ conversation }: { conversation: ConversationValue }) {
  const { t } = useLocale();
  const shop = useShop();
  const takes = permits(shop, TAKES_DRAFTS);
  const open =
    conversation.replyableUntil !== null && new Date(conversation.replyableUntil) > new Date();
  const drafts = useAdminQuery<DraftOrdersData>(
    ['draftOrders', 'OPEN', ''],
    DraftOrdersQuery,
    { query: null, status: 'OPEN' },
    { enabled: takes && open },
  );
  const send = useAdminMutation<
    { conversationDraftLinkSend: ConversationUpdatePayload },
    { id: string; draftOrderId: string }
  >(ConversationDraftLinkSendMutation);
  const [sending, setSending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  if (!takes || !open) return null;
  const offered = (drafts.data?.draftOrders.nodes ?? []).slice(0, OFFERED);

  const sendLink = async (draft: { id: string; name: string }) => {
    setOutcome(null);
    setSending(draft.id);
    try {
      const { conversationDraftLinkSend } = await send.mutateAsync({
        id: conversation.id,
        draftOrderId: draft.id,
      });
      const problem = conversationDraftLinkSend.userErrors[0];
      setOutcome(
        problem
          ? { tone: 'danger', text: userErrorText(problem, t) }
          : { tone: 'success', text: t('inbox.order.sent', { name: draft.name }) },
      );
    } catch (failure) {
      setOutcome({ tone: 'danger', text: errorText(failure, t) });
    } finally {
      setSending(null);
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{t('inbox.order.title')}</h2>
        <Link
          to="/$shopId/drafts/new"
          params={{ shopId: shop.id }}
          className="inline-flex min-h-10 items-center gap-1 text-primary hover:underline"
        >
          <FilePlus2 aria-hidden className="size-5" />
          {t('drafts.new')}
        </Link>
      </div>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('inbox.order.hint')}
      </p>
      {drafts.isSuccess && offered.length === 0 ? (
        <p className="text-secondary">{t('inbox.order.none')}</p>
      ) : (
        <ul aria-label={t('inbox.order.drafts')} className="divide-y divide-line">
          {offered.map((draft) => (
            <li key={draft.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{draft.name}</span>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t('drafts.items', {
                    count: draft.lineItems.reduce((sum, line) => sum + line.quantity, 0),
                  })}{' '}
                  · <span className="num">{formatMoney(draft.totalPrice.amount)}</span>
                </span>
              </span>
              <Button
                variant="secondary"
                busy={sending === draft.id}
                disabled={sending !== null && sending !== draft.id}
                icon={<Send aria-hidden className="size-5" />}
                aria-label={t('inbox.order.send', { name: draft.name })}
                onClick={() => void sendLink(draft)}
              >
                {t('inbox.order.sendShort')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {outcome && <Alert tone={outcome.tone}>{outcome.text}</Alert>}
    </Card>
  );
}
