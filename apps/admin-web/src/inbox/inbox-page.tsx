import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronRight, MessagesSquare } from 'lucide-react';
import type { ReactNode } from 'react';
import { ConversationsQuery } from '../api/operations';
import type {
  ConversationMessageValue,
  ConversationStatus,
  ConversationsData,
  ConversationValue,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import { gate, permits } from '../auth/permissions';
import { shownPhone } from '../customers/customers-page';
import { errorText } from '../i18n/errors';
import { formatCount, formatRelative } from '../i18n/format';
import { useLocale, type Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { ContactMessages } from './contact-messages';
import { SavedReplies } from './saved-replies';

const PAGE = 50;

/** The roles that read the shop's WhatsApp conversations; packers and accountants see none. */
export const READS_INBOX = gate(
  ['owner', 'manager', 'confirmation_agent', 'marketer'],
  'read_conversations',
);

/** Those who answer customers, mark conversations read and close them; marketers only read. */
export const WORKS_INBOX = gate(['owner', 'manager', 'confirmation_agent'], 'write_conversations');

/**
 * The conversations' tabs, the contact form's messages beside them (ADR-590), and the saved
 * replies (ADR-758).
 */
type InboxTab = 'open' | 'unread' | 'closed' | 'form' | 'replies';

/** The inbox's search: which tab, the open conversations when none. */
export interface InboxSearch {
  tab?: InboxTab;
}

export function validateInboxSearch(search: Record<string, unknown>): InboxSearch {
  const tab = search.tab;
  return tab === 'unread' || tab === 'closed' || tab === 'form' || tab === 'replies' ? { tab } : {};
}

/** Each tab: its name, what it asks the API for, and what it says when empty. */
const TABS: Record<
  Exclude<InboxTab, 'form' | 'replies'>,
  {
    label: MessageKey;
    status: ConversationStatus | null;
    unread: boolean | null;
    none: MessageKey;
    noneHint: MessageKey;
  }
> = {
  open: {
    label: 'inbox.tab.OPEN',
    status: 'OPEN',
    unread: null,
    none: 'inbox.noneOpen',
    noneHint: 'inbox.noneOpenHint',
  },
  unread: {
    label: 'inbox.tab.UNREAD',
    status: null,
    unread: true,
    none: 'inbox.noneUnread',
    noneHint: 'inbox.noneUnreadHint',
  },
  closed: {
    label: 'inbox.tab.CLOSED',
    status: 'CLOSED',
    unread: null,
    none: 'inbox.noneClosed',
    noneHint: 'inbox.noneClosedHint',
  },
};

/** What WhatsApp names the things a customer sends besides words, which the admin has words for. */
const MEDIA_KINDS = ['image', 'audio', 'video', 'document', 'location', 'sticker'];

/** What a customer sent besides words, in the merchant's words: "Photo", or "Attachment". */
export function mediaLabel(kind: string | null, t: Translate): string {
  return kind && MEDIA_KINDS.includes(kind)
    ? t(`inbox.media.${kind}` as MessageKey)
    : t('inbox.media.other');
}

/** A message in a line: its words, or what was sent in their place; the shop's own marked so. */
function preview(message: ConversationMessageValue, t: Translate): string {
  const text = message.body ?? mediaLabel(message.mediaKind, t);
  return message.direction === 'OUTBOUND' ? t('inbox.you', { text }) : text;
}

/** A conversation's unread messages as a count in a pill, said in full to screen readers. */
export function UnreadBadge({ count }: { count: number }) {
  const { t } = useLocale();
  return (
    <span className="num shrink-0 rounded-full bg-primary px-2 text-on-primary text-[length:var(--hatti-type-body-sm-size)] font-medium">
      <span aria-hidden>{formatCount(count)}</span>
      <span className="sr-only">{t('inbox.unread', { count: formatCount(count) })}</span>
    </span>
  );
}

function ConversationRow({
  conversation,
  timezone,
}: {
  conversation: ConversationValue;
  timezone: string;
}) {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const unread = conversation.unread > 0;
  return (
    <li>
      <Link
        to="/$shopId/inbox/$conversationId"
        params={{ shopId, conversationId: conversation.id }}
        className="flex items-center gap-3 px-4 py-3 hover:bg-canvas"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className={`num ${unread ? 'font-semibold' : 'font-medium'}`}>
              {shownPhone(conversation.customerPhone)}
            </span>
            {!conversation.viaOwnNumber && (
              <span className="text-secondary text-[length:var(--hatti-type-caption-size)]">
                {t('inbox.viaHatti')}
              </span>
            )}
            <span className="ms-auto shrink-0 text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {formatRelative(conversation.lastMessageAt, timezone, locale)}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span
              dir="auto"
              className={`min-w-0 flex-1 truncate ${unread ? 'text-text' : 'text-secondary'}`}
            >
              {conversation.lastMessage ? preview(conversation.lastMessage, t) : ''}
            </span>
            {unread && <UnreadBadge count={conversation.unread} />}
          </span>
        </span>
        <ChevronRight aria-hidden className="size-5 shrink-0 text-secondary rtl:rotate-180" />
      </Link>
    </li>
  );
}

/**
 * The inbox (MSG-05, ADR-545): what customers write to the shop on WhatsApp, the latest written
 * first, those still open, those unread or those closed, each with its last message and how many
 * are unread. Marketers read it; the rest who see it also answer.
 */
export function InboxPage() {
  const { tab = 'open' } = useSearch({ from: '/$shopId/inbox' });
  const works = permits(useShop(), WORKS_INBOX);
  return tab === 'form' ? (
    <InboxFrame tab="form" unreadCount={null}>
      <ContactMessages />
    </InboxFrame>
  ) : tab === 'replies' ? (
    <InboxFrame tab="replies" unreadCount={null}>
      <SavedReplies works={works} />
    </InboxFrame>
  ) : (
    <Conversations tab={tab} />
  );
}

/** The inbox's heading and tabs, around the tab shown. */
function InboxFrame({
  tab,
  unreadCount,
  children,
}: {
  tab: InboxTab;
  unreadCount: number | null;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const tabs: [InboxTab, MessageKey][] = [
    ...(Object.keys(TABS) as Exclude<InboxTab, 'form' | 'replies'>[]).map(
      (each): [InboxTab, MessageKey] => [each, TABS[each].label],
    ),
    ['form', 'inbox.tab.FORM'],
    ['replies', 'inbox.tab.REPLIES'],
  ];
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('inbox.title')}
        </h1>
        <p className="text-secondary">
          {t(
            tab === 'form'
              ? 'contactMessages.intro'
              : tab === 'replies'
                ? 'savedReplies.intro'
                : 'inbox.intro',
          )}
          {unreadCount !== null &&
            unreadCount > 0 &&
            ` · ${t('inbox.unreadCount', { count: formatCount(unreadCount) })}`}
        </p>
      </header>
      <div role="tablist" className="flex gap-2 overflow-x-auto pb-1">
        {tabs.map(([each, label]) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={tab === each}
            onClick={() =>
              void navigate({
                to: '/$shopId/inbox',
                params: { shopId: shop.id },
                search: each === 'open' ? {} : { tab: each },
              })
            }
            className={`inline-flex min-h-10 shrink-0 items-center rounded-full border px-3 ${
              tab === each
                ? 'border-primary bg-primary text-on-primary'
                : 'border-line bg-surface text-text'
            }`}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

/** The conversations of one of the inbox's tabs, a page at a time. */
function Conversations({ tab }: { tab: Exclude<InboxTab, 'form' | 'replies'> }) {
  const { t } = useLocale();
  const store = useSessionStore();
  const shop = useShop();
  const timezone = useShopTimezone();
  const { status, unread, none, noneHint } = TABS[tab];

  const conversations = useInfiniteQuery({
    queryKey: ['admin', shop.id, 'conversations', tab],
    queryFn: ({ pageParam }) =>
      store.graphql<ConversationsData>(shop.id, ConversationsQuery, {
        first: PAGE,
        after: pageParam,
        status,
        unread,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.conversations.pageInfo.hasNextPage ? last.conversations.pageInfo.endCursor : undefined,
  });

  const shown = conversations.data?.pages.flatMap((page) => page.conversations.nodes) ?? [];
  const unreadCount = conversations.data?.pages[0]?.conversationsUnreadCount ?? 0;

  return (
    <InboxFrame tab={tab} unreadCount={unreadCount}>
      {conversations.isPending ? (
        <Loading label={t('state.loading')} />
      ) : conversations.isError ? (
        <ErrorState
          message={errorText(conversations.error, t)}
          action={<Button onClick={() => void conversations.refetch()}>{t('action.retry')}</Button>}
        />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={<MessagesSquare aria-hidden className="size-8 text-secondary" />}
            title={t(none)}
            body={t(noneHint)}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {shown.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                timezone={timezone}
              />
            ))}
          </ul>
          {conversations.hasNextPage && (
            <div className="border-t border-line p-3 text-center">
              <Button
                variant="tertiary"
                busy={conversations.isFetchingNextPage}
                onClick={() => void conversations.fetchNextPage()}
              >
                {t('orders.more')}
              </Button>
            </div>
          )}
        </Card>
      )}
    </InboxFrame>
  );
}
