import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Archive,
  Check,
  CheckCheck,
  CircleAlert,
  FileText,
  ImageIcon,
  MapPin,
  Mic,
  Paperclip,
  RotateCcw,
  Send,
  Sticker,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ConversationAssignMutation,
  ConversationMarkReadMutation,
  ConversationMessagesQuery,
  ConversationQuery,
  ConversationReplyMutation,
  ConversationUpdateStatusMutation,
  StaffQuery,
} from '../api/operations';
import type {
  ConversationData,
  ConversationMessagesData,
  ConversationMessageValue,
  ConversationReplyData,
  ConversationReplyStatus,
  ConversationStatus,
  ConversationUpdatePayload,
  ConversationValue,
  StaffData,
} from '../api/types';
import { useMe, useSessionStore } from '../auth/context';
import { permits } from '../auth/permissions';
import { shownPhone } from '../customers/customers-page';
import { ASSIGNS } from '../orders/details';
import { errorText, userErrorText } from '../i18n/errors';
import { formatCount, formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { ConversationLabels } from './conversation-labels';
import { ConversationOrder } from './conversation-order';
import { mediaLabel, UnreadBadge, WORKS_INBOX } from './inbox-page';
import { SavedReplyPicker } from './saved-replies';

const PAGE = 50;

/** The longest reply WhatsApp takes, in characters. */
const REPLY_MAX = 4096;

/** The icon of what a customer sent besides words, as WhatsApp names it. */
const MEDIA_ICONS: Record<string, LucideIcon> = {
  image: ImageIcon,
  audio: Mic,
  video: Video,
  document: FileText,
  location: MapPin,
  sticker: Sticker,
};

/** How a reply went, as words and an icon. */
const REPLY_STATUSES: Record<
  ConversationReplyStatus,
  { label: MessageKey; icon: LucideIcon; className: string }
> = {
  SENT: { label: 'inbox.status.SENT', icon: Check, className: 'text-secondary' },
  DELIVERED: { label: 'inbox.status.DELIVERED', icon: CheckCheck, className: 'text-secondary' },
  READ: { label: 'inbox.status.READ', icon: CheckCheck, className: 'text-info' },
  FAILED: { label: 'inbox.status.FAILED', icon: CircleAlert, className: 'text-danger' },
};

/**
 * One message: the customer's at the start, the shop's at the end with how it went. What the
 * customer sent besides words is named, and is on their phone alone.
 */
function Message({ message, timezone }: { message: ConversationMessageValue; timezone: string }) {
  const { t, locale } = useLocale();
  const outbound = message.direction === 'OUTBOUND';
  const status = outbound && message.status ? REPLY_STATUSES[message.status] : null;
  const MediaIcon = (message.mediaKind && MEDIA_ICONS[message.mediaKind]) || Paperclip;
  return (
    <li
      className={`flex max-w-[85%] flex-col gap-1 rounded-card border px-3 py-2 ${
        outbound ? 'ms-auto border-primary/20 bg-primary/10' : 'me-auto border-line bg-surface'
      }`}
    >
      {(message.mediaKind || !message.body) && (
        <span className="flex flex-col">
          <span className="inline-flex items-center gap-1 font-medium">
            <MediaIcon aria-hidden className="size-4" />
            {mediaLabel(message.mediaKind, t)}
          </span>
          <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('inbox.mediaNote')}
          </span>
        </span>
      )}
      {message.body && (
        <p dir="auto" className="break-words whitespace-pre-wrap">
          {message.body}
        </p>
      )}
      <span className="flex flex-wrap items-center gap-x-2 text-secondary text-[length:var(--hatti-type-caption-size)]">
        <time dateTime={message.at}>{formatDateTime(message.at, timezone, locale)}</time>
        {status && (
          <span className={`inline-flex items-center gap-1 ${status.className}`}>
            <status.icon aria-hidden className="size-4" />
            {t(status.label)}
          </span>
        )}
      </span>
      {message.status === 'FAILED' && message.error && (
        <span dir="auto" className="text-danger text-[length:var(--hatti-type-body-sm-size)]">
          {message.error}
        </span>
      )}
    </li>
  );
}

/**
 * The shop's answer in its own words, while WhatsApp allows it: within a day of the customer's
 * last message. Past it, why not and what to do instead.
 */
function ReplyBox({
  conversation,
  timezone,
}: {
  conversation: ConversationValue;
  timezone: string;
}) {
  const { t, locale } = useLocale();
  const reply = useAdminMutation<ConversationReplyData, { id: string; body: string }>(
    ConversationReplyMutation,
  );
  const [body, setBody] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const until = conversation.replyableUntil;
  const text = body.trim();

  const onSend = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { conversationReply } = await reply.mutateAsync({ id: conversation.id, body: text });
      if (conversationReply.userErrors[0]) {
        setProblem(userErrorText(conversationReply.userErrors[0], t));
      } else setBody('');
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  if (!until || new Date(until).getTime() <= Date.now()) {
    return (
      <div className="flex flex-col gap-2">
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Alert tone="info">{t('inbox.windowClosed')}</Alert>
      </div>
    );
  }
  return (
    <form onSubmit={(event) => void onSend(event)} className="flex flex-col gap-2">
      <label htmlFor="inbox-reply" className="font-medium">
        {t('inbox.reply')}
      </label>
      <textarea
        id="inbox-reply"
        value={body}
        rows={3}
        dir="auto"
        maxLength={REPLY_MAX}
        onChange={(event) => setBody(event.target.value)}
        className="rounded-control border border-line bg-surface px-3 py-2 text-text"
      />
      <SavedReplyPicker
        onPick={(saved) =>
          setBody((current) => (current.trim() ? `${current.trimEnd()}\n${saved}` : saved))
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('inbox.replyCount', { count: formatCount(text.length), most: formatCount(REPLY_MAX) })}
        </span>
        <Button
          type="submit"
          busy={reply.isPending}
          disabled={!text}
          icon={<Send aria-hidden className="size-5 rtl:-scale-x-100" />}
        >
          {t('inbox.send')}
        </Button>
      </div>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('inbox.replyUntil', { time: formatDateTime(until, timezone, locale) })}
      </p>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </form>
  );
}

/**
 * Who answers the conversation (MSG-06, ADR-759): those who give orders to others give it to
 * anyone on the staff, or to no one; others who answer take one no one has, and give back their
 * own; marketers see who has it.
 */
function ConversationAssignment({
  conversation,
  works,
}: {
  conversation: ConversationValue;
  works: boolean;
}) {
  const { t } = useLocale();
  const shop = useShop();
  const me = useMe().data?.user.id;
  const leads = works && permits(shop, ASSIGNS);
  const staff = useAdminQuery<StaffData>(['staff'], StaffQuery, undefined, { enabled: leads });
  const assign = useAdminMutation<
    { conversationAssign: ConversationUpdatePayload },
    { id: string; staffMemberId: string | null }
  >(ConversationAssignMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const assignee = conversation.assignee ?? null;

  const give = async (staffMemberId: string | null) => {
    setProblem(null);
    try {
      const { conversationAssign } = await assign.mutateAsync({
        id: conversation.id,
        staffMemberId,
      });
      if (conversationAssign.userErrors[0]) {
        setProblem(userErrorText(conversationAssign.userErrors[0], t));
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  if (!works) {
    return assignee ? (
      <p className="text-secondary">{t('inbox.givenTo', { name: assignee.name })}</p>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-2">
      {leads ? (
        <SelectField<string>
          label={t('inbox.assignee')}
          value={assignee?.id ?? ''}
          options={[
            { value: '', label: t('details.nobody') },
            ...(staff.data?.staffMembers ?? (assignee ? [assignee] : [])).map((member) => ({
              value: member.id,
              label: member.id === me ? t('details.me', { name: member.name }) : member.name,
            })),
          ]}
          onChange={(value) => void give(value || null)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex-1">
            {assignee ? t('inbox.givenTo', { name: assignee.name }) : t('inbox.nobodyYet')}
          </span>
          {!assignee && me && (
            <Button variant="secondary" busy={assign.isPending} onClick={() => void give(me)}>
              {t('inbox.take')}
            </Button>
          )}
          {assignee?.id === me && (
            <Button variant="tertiary" busy={assign.isPending} onClick={() => void give(null)}>
              {t('details.giveBack')}
            </Button>
          )}
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

/**
 * A conversation with a customer on WhatsApp (MSG-05, ADR-546): its messages, the oldest first and
 * older ones a page at a time. Those who work the inbox read it as it opens, close it or open it
 * again, and answer in the shop's own words; marketers only read.
 */
export function ConversationPage() {
  const { t } = useLocale();
  const store = useSessionStore();
  const shop = useShop();
  const timezone = useShopTimezone();
  const { conversationId } = useParams({ from: '/$shopId/inbox/$conversationId' });
  const works = permits(shop, WORKS_INBOX);
  const query = useAdminQuery<ConversationData>(
    ['conversation', conversationId],
    ConversationQuery,
    { id: conversationId },
  );
  const messages = useInfiniteQuery({
    queryKey: ['admin', shop.id, 'conversationMessages', conversationId],
    queryFn: ({ pageParam }) =>
      store.graphql<ConversationMessagesData>(shop.id, ConversationMessagesQuery, {
        conversationId,
        first: PAGE,
        before: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.conversationMessages.pageInfo.hasNextPage
        ? last.conversationMessages.pageInfo.endCursor
        : undefined,
  });
  const { mutate: markRead } = useAdminMutation<
    { conversationMarkRead: ConversationUpdatePayload },
    { id: string }
  >(ConversationMarkReadMutation);
  const update = useAdminMutation<
    { conversationUpdateStatus: ConversationUpdatePayload },
    { id: string; status: ConversationStatus }
  >(ConversationUpdateStatusMutation);
  const [problem, setProblem] = useState<string | null>(null);
  /** The conversation marked read as it opened, so it is marked once. */
  const marked = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const conversation = query.data?.conversation;
  // The API gives the latest first; the thread reads down to the latest.
  const thread = (messages.data?.pages.flatMap((page) => page.conversationMessages.nodes) ?? [])
    .slice()
    .reverse();
  const latest = thread.at(-1)?.id;

  useEffect(() => {
    if (!works || !conversation || conversation.unread === 0) return;
    if (marked.current === conversation.id) return;
    marked.current = conversation.id;
    markRead({ id: conversation.id });
  }, [works, conversation, markRead]);

  useEffect(() => {
    if (latest) end.current?.scrollIntoView?.({ block: 'end' });
  }, [latest]);

  const setStatus = async (status: ConversationStatus) => {
    setProblem(null);
    try {
      const { conversationUpdateStatus } = await update.mutateAsync({ id: conversationId, status });
      if (conversationUpdateStatus.userErrors[0]) {
        setProblem(userErrorText(conversationUpdateStatus.userErrors[0], t));
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const back = (
    <Link
      to="/$shopId/inbox"
      params={{ shopId: shop.id }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('inbox.title')}
    </Link>
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  if (!conversation) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {back}
        <EmptyState title={t('inbox.notFound')} />
      </div>
    );
  }

  const closed = conversation.status === 'CLOSED';
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="num flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
            {shownPhone(conversation.customerPhone)}
            {conversation.unread > 0 && <UnreadBadge count={conversation.unread} />}
          </h1>
          <p className="text-secondary">
            {t(conversation.viaOwnNumber ? 'inbox.wroteToOwn' : 'inbox.wroteToHatti')}
          </p>
        </div>
        {works && (
          <Button
            variant="secondary"
            busy={update.isPending}
            icon={
              closed ? (
                <RotateCcw aria-hidden className="size-5" />
              ) : (
                <Archive aria-hidden className="size-5" />
              )
            }
            onClick={() => void setStatus(closed ? 'OPEN' : 'CLOSED')}
          >
            {t(closed ? 'inbox.reopen' : 'inbox.close')}
          </Button>
        )}
      </header>
      <ConversationAssignment conversation={conversation} works={works} />
      <ConversationLabels conversation={conversation} works={works} />
      {works && <ConversationOrder conversation={conversation} />}
      {closed && <Alert tone="info">{t('inbox.closedNote')}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Card className="flex flex-col gap-3 p-4">
        {messages.hasNextPage && (
          <Button
            variant="tertiary"
            className="self-center"
            busy={messages.isFetchingNextPage}
            onClick={() => void messages.fetchNextPage()}
          >
            {t('inbox.older')}
          </Button>
        )}
        {messages.isPending ? (
          <Loading label={t('state.loading')} />
        ) : messages.isError ? (
          <ErrorState
            message={errorText(messages.error, t)}
            action={<Button onClick={() => void messages.refetch()}>{t('action.retry')}</Button>}
          />
        ) : thread.length === 0 ? (
          <p className="p-4 text-center text-secondary">{t('inbox.noMessages')}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {thread.map((message) => (
              <Message key={message.id} message={message} timezone={timezone} />
            ))}
          </ol>
        )}
        <div ref={end} />
      </Card>
      {works && <ReplyBox key={conversation.id} conversation={conversation} timezone={timezone} />}
    </div>
  );
}
