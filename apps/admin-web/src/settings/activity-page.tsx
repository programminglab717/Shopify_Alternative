import { Link } from '@tanstack/react-router';
import { History } from 'lucide-react';
import { useState } from 'react';
import { ActivityQuery, AuditQuery } from '../api/operations';
import type { ActivityActor, ActivityData, AuditData, StaffMemberRole } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import { messages } from '../i18n/messages';
import type { MessageKey } from '../i18n/messages';
import { useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { BackToSettings, roleLabel } from './settings-page';

/** A key in the admin's words, if it has one. */
function known(key: string): key is MessageKey {
  return key in messages.en;
}

/** "product_variant" as words, for a subject or verb the admin has no words for. */
function plain(name: string): string {
  return name.replace(/[._]/g, ' ');
}

/**
 * What an event or audit action says happened, in the merchant's words: "Product updated" from
 * `product.updated`. A subject or verb the admin has no words for reads as it is named.
 */
export function describe(type: string, t: Translate): string {
  const dot = type.indexOf('.');
  const subject = dot < 0 ? type : type.slice(0, dot);
  const verb = dot < 0 ? '' : type.slice(dot + 1);
  const subjectKey = `activity.subject.${subject}`;
  const verbKey = `activity.verb.${verb}`;
  return t('activity.what', {
    subject: known(subjectKey) ? t(subjectKey) : plain(subject),
    verb: known(verbKey) ? t(verbKey) : plain(verb),
  });
}

/** Who did it: a member of staff by name, or by role once they have gone; an app; support. */
function who(actor: ActivityActor, names: Map<string, string>, t: Translate): string {
  if (actor.kind === 'APP') return t('activity.app');
  if (actor.kind === 'SUPPORT') return t('activity.support');
  const name = names.get(actor.id);
  if (name) return name;
  return actor.role
    ? t(roleLabel(actor.role.toUpperCase() as StaffMemberRole))
    : t('activity.someone');
}

/** The page an entry's subject has in the admin, where it has one. */
function SubjectLink({ id, label }: { id: string | null; label: string }) {
  const shopId = useShop().id;
  const prefix = id?.slice(0, id.indexOf('_'));
  if (id && prefix === 'prod') {
    return (
      <Link
        to="/$shopId/products/$productId"
        params={{ shopId, productId: id }}
        className="underline"
      >
        {label}
      </Link>
    );
  }
  if (id && prefix === 'ord') {
    return (
      <Link to="/$shopId/orders/$orderId" params={{ shopId, orderId: id }} className="underline">
        {label}
      </Link>
    );
  }
  if (id && prefix === 'cus') {
    return (
      <Link
        to="/$shopId/customers/$customerId"
        params={{ shopId, customerId: id }}
        className="underline"
      >
        {label}
      </Link>
    );
  }
  if (id && prefix === 'dft') {
    return (
      <Link to="/$shopId/drafts/$draftId" params={{ shopId, draftId: id }} className="underline">
        {label}
      </Link>
    );
  }
  return <>{label}</>;
}

interface Entry {
  id: string;
  what: string;
  subjectId: string | null;
  occurredAt: string;
  actor: ActivityActor;
}

function Entries({
  entries,
  names,
  more,
  onMore,
  busy,
}: {
  entries: Entry[];
  names: Map<string, string>;
  more: boolean;
  onMore: () => void;
  busy: boolean;
}) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  if (entries.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<History aria-hidden className="size-8 text-secondary" />}
          title={t('activity.none')}
        />
      </Card>
    );
  }
  return (
    <>
      <Card>
        <ul className="divide-y divide-line">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-0.5 px-4 py-3">
              <span className="font-medium">
                <SubjectLink id={entry.subjectId} label={entry.what} />
              </span>
              <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                <span dir="auto">{who(entry.actor, names, t)}</span> ·{' '}
                {formatDateTime(entry.occurredAt, timezone, locale)}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      {more && (
        <Button variant="secondary" busy={busy} className="self-start" onClick={onMore}>
          {t('activity.older')}
        </Button>
      )}
    </>
  );
}

const PAGE = 50;
const MOST = 250;

function Changes() {
  const { t } = useLocale();
  const [first, setFirst] = useState(PAGE);
  const query = useAdminQuery<ActivityData>(['activity', first], ActivityQuery, { first });
  const data = query.data;
  if (!data) {
    return query.isError ? (
      <ErrorState message={errorText(query.error, t)} />
    ) : (
      <Loading label={t('state.loading')} />
    );
  }
  return (
    <Entries
      entries={data.activityLog.nodes.map((node) => ({ ...node, what: describe(node.type, t) }))}
      names={new Map(data.staffMembers.map((member) => [member.id, member.name]))}
      more={data.activityLog.pageInfo.hasNextPage && first < MOST}
      busy={query.isFetching}
      onMore={() => setFirst(Math.min(first + PAGE, MOST))}
    />
  );
}

function Sensitive() {
  const { t } = useLocale();
  const [first, setFirst] = useState(PAGE);
  const query = useAdminQuery<AuditData>(['audit', first], AuditQuery, { first });
  const data = query.data;
  if (!data) {
    return query.isError ? (
      <ErrorState message={errorText(query.error, t)} />
    ) : (
      <Loading label={t('state.loading')} />
    );
  }
  return (
    <Entries
      entries={data.auditLog.nodes.map((node) => ({ ...node, what: describe(node.action, t) }))}
      names={new Map(data.staffMembers.map((member) => [member.id, member.name]))}
      more={data.auditLog.pageInfo.hasNextPage && first < MOST}
      busy={query.isFetching}
      onMore={() => setFirst(Math.min(first + PAGE, MOST))}
    />
  );
}

/**
 * The shop's activity (ADM-04, ADR-256): what its staff and apps changed, newest first, by whom
 * and when, each linking to what it changed where the admin has a page for it; and, apart, what
 * the shop may need to account for, such as numbers seen, customers exported and what Hatti's
 * support looked at. Owners and managers.
 */
export function ActivityPage() {
  const { t } = useLocale();
  const [tab, setTab] = useState<'changes' | 'sensitive'>('changes');
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.activity')}
      </h1>
      <div role="tablist" className="flex gap-2">
        {(['changes', 'sensitive'] as const).map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={tab === each}
            onClick={() => setTab(each)}
            className={`min-h-10 rounded-full border px-4 ${
              tab === each ? 'border-primary bg-primary text-on-primary' : 'border-line'
            }`}
          >
            {t(`activity.tab.${each}`)}
          </button>
        ))}
      </div>
      {tab === 'changes' ? <Changes /> : <Sensitive />}
    </div>
  );
}
