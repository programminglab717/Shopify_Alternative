import { useInfiniteQuery } from '@tanstack/react-query';
import { FileText, Mail, MessageCircle, Phone, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  ContactMessageDeleteMutation,
  ContactMessageMarkReadMutation,
  ContactMessagesQuery,
} from '../api/operations';
import type {
  ContactMessageDeleteData,
  ContactMessageMarkReadData,
  ContactMessagesData,
  ContactMessageValue,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import { permits } from '../auth/permissions';
import { shownPhone } from '../customers/customers-page';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { WORKS_INBOX } from './inbox-page';

const PAGE = 50;

/** A whole number a link can dial or open WhatsApp at; null for one shown masked. */
function dialable(phone: string | null): string | null {
  return phone && /^\+\d{8,15}$/.test(phone) ? phone : null;
}

function ContactMessageRow({
  message,
  timezone,
}: {
  message: ContactMessageValue;
  timezone: string;
}) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const works = permits(shop, WORKS_INBOX);
  const markRead = useAdminMutation<ContactMessageMarkReadData, { id: string; read: boolean }>(
    ContactMessageMarkReadMutation,
  );
  const remove = useAdminMutation<ContactMessageDeleteData, { id: string }>(
    ContactMessageDeleteMutation,
  );
  const { problem, attempt } = useAttempt();
  const [asking, setAsking] = useState(false);
  const unread = message.readAt === null;
  const number = dialable(message.phone);

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={unread ? 'font-semibold' : 'font-medium'} dir="auto">
          {message.name ?? t('contactMessages.noName')}
        </span>
        <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {unread && (
            <span className="me-2 rounded-full bg-primary px-2 text-on-primary font-medium">
              {t('contactMessages.new')}
            </span>
          )}
          {formatDateTime(message.receivedAt, timezone, locale)}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-secondary">
        {message.phone && (
          <span className="inline-flex items-center gap-1">
            <Phone aria-hidden className="size-4" />
            {number ? (
              <a className="num text-primary underline" href={`tel:${number}`}>
                {shownPhone(message.phone)}
              </a>
            ) : (
              <span className="num">{shownPhone(message.phone)}</span>
            )}
          </span>
        )}
        {number && (
          <a
            className="inline-flex items-center gap-1 text-primary underline"
            href={`https://wa.me/${number.slice(1)}`}
            target="_blank"
            rel="noreferrer"
          >
            <MessageCircle aria-hidden className="size-4" />
            {t('contactMessages.whatsapp')}
          </a>
        )}
        {message.email && (
          <a
            className="inline-flex items-center gap-1 text-primary underline"
            href={`mailto:${message.email}`}
            dir="ltr"
          >
            <Mail aria-hidden className="size-4" />
            {message.email}
          </a>
        )}
      </div>
      <p className="whitespace-pre-line" dir="auto">
        {message.body}
      </p>
      {message.fields.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {message.fields.map((field) => (
            <div key={field.name} className="contents">
              <dt className="text-secondary" dir="auto">
                {field.name}
              </dt>
              <dd dir="auto">{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {message.page && (
        <p className="inline-flex items-center gap-1 text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          <FileText aria-hidden className="size-4" />
          {t('contactMessages.from', { page: message.page })}
        </p>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {works &&
        (asking ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>{t('contactMessages.deleteAsk')}</span>
            <Button
              variant="destructive"
              busy={remove.isPending}
              onClick={() =>
                void attempt(async () => {
                  const done = await remove.mutateAsync({ id: message.id });
                  return done.contactMessageDelete;
                })
              }
            >
              {t('contactMessages.deleteConfirm')}
            </Button>
            <Button variant="tertiary" onClick={() => setAsking(false)}>
              {t('returns.cancel')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              busy={markRead.isPending}
              onClick={() =>
                void attempt(async () => {
                  const done = await markRead.mutateAsync({ id: message.id, read: unread });
                  return done.contactMessageMarkRead;
                })
              }
            >
              {t(unread ? 'contactMessages.markRead' : 'contactMessages.markUnread')}
            </Button>
            <Button
              variant="tertiary"
              icon={<Trash2 aria-hidden className="size-5" />}
              onClick={() => setAsking(true)}
            >
              {t('contactMessages.delete')}
            </Button>
          </div>
        ))}
    </li>
  );
}

/**
 * What shoppers wrote through the online store's contact form (OS-08, ADR-590), the latest first,
 * in the inbox beside the conversations: who wrote, how to answer them (a call, WhatsApp or an
 * email), what they wrote, the form's other fields and its page. Those who answer customers mark
 * them read or unread and delete them; marketers only read.
 */
export function ContactMessages() {
  const { t } = useLocale();
  const store = useSessionStore();
  const shop = useShop();
  const timezone = useShopTimezone();
  const messages = useInfiniteQuery({
    queryKey: ['admin', shop.id, 'contactMessages'],
    queryFn: ({ pageParam }) =>
      store.graphql<ContactMessagesData>(shop.id, ContactMessagesQuery, {
        first: PAGE,
        after: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) =>
      last.contactMessages.pageInfo.hasNextPage
        ? last.contactMessages.pageInfo.endCursor
        : undefined,
  });
  const shown = messages.data?.pages.flatMap((page) => page.contactMessages.nodes) ?? [];

  if (messages.isPending) return <Loading label={t('state.loading')} />;
  if (messages.isError) {
    return (
      <ErrorState
        message={errorText(messages.error, t)}
        action={<Button onClick={() => void messages.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  if (shown.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Mail aria-hidden className="size-8 text-secondary" />}
          title={t('contactMessages.none')}
          body={t('contactMessages.noneHint')}
        />
      </Card>
    );
  }
  return (
    <Card>
      <ul className="divide-y divide-line">
        {shown.map((message) => (
          <ContactMessageRow key={message.id} message={message} timezone={timezone} />
        ))}
      </ul>
      {messages.hasNextPage && (
        <div className="border-t border-line p-3 text-center">
          <Button
            variant="tertiary"
            busy={messages.isFetchingNextPage}
            onClick={() => void messages.fetchNextPage()}
          >
            {t('orders.more')}
          </Button>
        </div>
      )}
    </Card>
  );
}
