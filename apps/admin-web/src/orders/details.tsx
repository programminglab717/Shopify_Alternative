import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  OrderAssignMutation,
  OrderCommentCreateMutation,
  OrderCommentDeleteMutation,
  OrderCommentUpdateMutation,
  OrderUpdateMutation,
  StaffQuery,
} from '../api/operations';
import type { OrderDetail, ParcelUserErrorsData, StaffData } from '../api/types';
import { useMe } from '../auth/context';
import type { StaffRole } from '../auth/session';
import { formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { parseTags, TextArea } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { WORKS_PARCELS } from './parcels';

/** Owners and managers give orders to anyone, take them from whoever has them, and delete any comment. */
const LEADS: readonly StaffRole[] = ['owner', 'manager'];

/** A comment's longest, as the core takes it. */
const COMMENT_MOST = 2000;

/**
 * Who sees the order through (ORD-10, ADR-127): owners and managers give it to anyone on the
 * staff, or to no one; other staff take one no one has, and give back their own.
 */
export function Assignment({ order }: { order: OrderDetail }) {
  const { t } = useLocale();
  const { role } = useShop();
  const me = useMe().data?.user.id;
  const leads = LEADS.includes(role);
  const staff = useAdminQuery<StaffData>(['staff'], StaffQuery, undefined, { enabled: leads });
  const assign = useAdminMutation<
    ParcelUserErrorsData,
    { id: string; staffMemberId: string | null }
  >(OrderAssignMutation);
  const { problem, attempt } = useAttempt();
  const mine = order.assignee?.id === me;

  const give = (staffMemberId: string | null) =>
    void attempt(
      async () => (await assign.mutateAsync({ id: order.id, staffMemberId })).orderAssign!,
    );

  if (!WORKS_PARCELS.includes(role)) {
    return order.assignee ? (
      <p className="text-secondary">{t('order.assignee', { name: order.assignee.name })}</p>
    ) : null;
  }

  return (
    <div className="flex flex-col gap-2">
      {leads ? (
        <SelectField<string>
          label={t('details.assignee')}
          value={order.assignee?.id ?? ''}
          options={[
            { value: '', label: t('details.nobody') },
            ...(staff.data?.staffMembers ?? (order.assignee ? [order.assignee] : [])).map(
              (member) => ({
                value: member.id,
                label: member.id === me ? t('details.me', { name: member.name }) : member.name,
              }),
            ),
          ]}
          onChange={(value) => give(value || null)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex-1">
            {order.assignee
              ? t('order.assignee', { name: order.assignee.name })
              : t('details.nobodyYet')}
          </span>
          {!order.assignee && me && (
            <Button variant="secondary" busy={assign.isPending} onClick={() => give(me)}>
              {t('details.take')}
            </Button>
          )}
          {mine && (
            <Button variant="tertiary" busy={assign.isPending} onClick={() => give(null)}>
              {t('details.giveBack')}
            </Button>
          )}
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

type Event = OrderDetail['events']['nodes'][number];

/** A comment's words changed in place, by its author. */
function EditComment({ event, onDone }: { event: Event; onDone: () => void }) {
  const { t } = useLocale();
  const [message, setMessage] = useState(event.message);
  const update = useAdminMutation<ParcelUserErrorsData, { id: string; message: string }>(
    OrderCommentUpdateMutation,
  );
  const { problem, attempt } = useAttempt();
  const ready = message.trim().length > 0 && message.length <= COMMENT_MOST;

  const submit = async (form: FormEvent) => {
    form.preventDefault();
    if (!ready) return;
    const done = await attempt(
      async () =>
        (await update.mutateAsync({ id: event.id, message: message.trim() })).orderCommentUpdate!,
    );
    if (done) onDone();
  };

  return (
    <form onSubmit={(form) => void submit(form)} className="flex flex-col gap-2">
      <TextArea label={t('details.comment')} value={message} onChange={setMessage} />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={update.isPending} disabled={!ready}>
          {t('details.save')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The order's timeline (ORD-02, ADR-128): what happened and what staff wrote, the newest first,
 * each signed; a comment written for whoever picks the order up next, naming staff with @ to tell
 * them on WhatsApp; its author changes or deletes it, and owners and managers delete anyone's.
 */
export function Timeline({ order, timezone }: { order: OrderDetail; timezone: string }) {
  const { t, locale } = useLocale();
  const { role } = useShop();
  const me = useMe().data?.user.id;
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const create = useAdminMutation<ParcelUserErrorsData, { orderId: string; message: string }>(
    OrderCommentCreateMutation,
  );
  const remove = useAdminMutation<ParcelUserErrorsData, { id: string }>(OrderCommentDeleteMutation);
  const { problem, attempt } = useAttempt();
  const writes = WORKS_PARCELS.includes(role);
  const ready = message.trim().length > 0 && message.length <= COMMENT_MOST;

  const submit = async (form: FormEvent) => {
    form.preventDefault();
    if (!ready) return;
    const done = await attempt(
      async () =>
        (await create.mutateAsync({ orderId: order.id, message: message.trim() }))
          .orderCommentCreate!,
    );
    if (done) setMessage('');
  };

  return (
    <div className="flex flex-col gap-4">
      {writes && (
        <form onSubmit={(form) => void submit(form)} className="flex flex-col gap-2">
          <TextArea label={t('details.comment')} value={message} onChange={setMessage} />
          <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {message.length > COMMENT_MOST
              ? t('details.tooLong', { most: COMMENT_MOST })
              : t('details.commentHint')}
          </p>
          <Button type="submit" className="self-start" busy={create.isPending} disabled={!ready}>
            {t('details.addComment')}
          </Button>
        </form>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <ol className="flex flex-col gap-3">
        {order.events.nodes.map((event) => {
          const comment = event.kind === 'comment';
          // Their own, while they still work orders: the core refuses anyone else.
          const own = writes && comment && event.author?.id === me;
          return (
            <li
              key={event.id}
              className={`flex flex-col ${comment ? 'rounded-control bg-canvas p-3' : ''}`}
            >
              {editing === event.id ? (
                <EditComment event={event} onDone={() => setEditing(null)} />
              ) : (
                <>
                  <span className="whitespace-pre-line" dir="auto">
                    {event.message}
                  </span>
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {event.author?.name ? `${event.author.name} · ` : ''}
                    {formatRelative(event.createdAt, timezone, locale)}
                    {event.editedAt ? ` · ${t('details.edited')}` : ''}
                  </span>
                  {(own || (comment && LEADS.includes(role))) && (
                    <span className="flex gap-3 pt-1">
                      {own && (
                        <button
                          type="button"
                          className="text-secondary underline"
                          onClick={() => setEditing(event.id)}
                        >
                          {t('details.edit')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-danger underline"
                        onClick={() =>
                          void attempt(
                            async () =>
                              (await remove.mutateAsync({ id: event.id })).orderCommentDelete!,
                          )
                        }
                      >
                        {t('details.delete')}
                      </button>
                    </span>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The order's note and tags (ORD-02), changed by those who work orders. */
export function NoteAndTags({ order }: { order: OrderDetail }) {
  const { t } = useLocale();
  const { role } = useShop();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(order.note ?? '');
  const [tags, setTags] = useState(order.tags.join(', '));
  const update = useAdminMutation<ParcelUserErrorsData, Record<string, unknown>>(
    OrderUpdateMutation,
  );
  const { problem, attempt } = useAttempt();
  const writes = WORKS_PARCELS.includes(role);

  const submit = async (form: FormEvent) => {
    form.preventDefault();
    const done = await attempt(
      async () =>
        (
          await update.mutateAsync({
            id: order.id,
            input: { note: note.trim(), tags: parseTags(tags) },
          })
        ).orderUpdate!,
    );
    if (done) setEditing(false);
  };

  if (editing) {
    return (
      <form onSubmit={(form) => void submit(form)} className="flex flex-col gap-3">
        <TextArea label={t('details.note')} value={note} onChange={setNote} />
        <TextField
          label={t('details.tags')}
          hint={t('details.tagsHint')}
          value={tags}
          onChange={(event) => setTags(event.target.value)}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={update.isPending}>
            {t('details.save')}
          </Button>
          <Button variant="tertiary" onClick={() => setEditing(false)}>
            {t('returns.cancel')}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {order.note ? (
        <p className="whitespace-pre-line" dir="auto">
          {order.note}
        </p>
      ) : (
        <p className="text-secondary">{t('details.noNote')}</p>
      )}
      {order.tags.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {order.tags.map((tag) => (
            <li key={tag} className="rounded-full border border-line px-3 py-0.5" dir="auto">
              {tag}
            </li>
          ))}
        </ul>
      )}
      {writes && (
        <Button
          variant="tertiary"
          className="self-start"
          onClick={() => {
            setNote(order.note ?? '');
            setTags(order.tags.join(', '));
            setEditing(true);
          }}
        >
          {t('details.edit')}
        </Button>
      )}
    </div>
  );
}

type AddressFields = Record<
  'name' | 'phone' | 'address1' | 'address2' | 'landmark' | 'city' | 'province',
  string
>;

/**
 * The delivery address, corrected before anything ships (ADR-070, ADR-259): the whole of it replaced,
 * its map pin dropped with it, as one the customer shared would no longer be where it points.
 */
export function DeliveryAddress({ order }: { order: OrderDetail }) {
  const { t } = useLocale();
  const { role } = useShop();
  const address = order.shippingAddress;
  const blank = (): AddressFields => ({
    name: address.name ?? '',
    phone: address.phone ?? '',
    address1: address.address1 ?? '',
    address2: address.address2 ?? '',
    landmark: address.landmark ?? '',
    city: address.city,
    province: address.province ?? '',
  });
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<AddressFields>(blank);
  const update = useAdminMutation<ParcelUserErrorsData, Record<string, unknown>>(
    OrderUpdateMutation,
  );
  const { problem, attempt } = useAttempt();
  const correctable =
    WORKS_PARCELS.includes(role) && order.status !== 'CANCELLED' && order.fulfillments.length === 0;
  const ready = ['name', 'phone', 'address1', 'city'].every(
    (key) => fields[key as keyof AddressFields].trim().length > 0,
  );
  const set = (key: keyof AddressFields) => (event: { target: { value: string } }) =>
    setFields({ ...fields, [key]: event.target.value });

  const submit = async (form: FormEvent) => {
    form.preventDefault();
    if (!ready) return;
    const optional = (value: string) => value.trim() || null;
    const done = await attempt(
      async () =>
        (
          await update.mutateAsync({
            id: order.id,
            input: {
              shippingAddress: {
                name: fields.name.trim(),
                phone: fields.phone.trim(),
                address1: fields.address1.trim(),
                address2: optional(fields.address2),
                landmark: optional(fields.landmark),
                city: fields.city.trim(),
                province: optional(fields.province),
                ...(address.zip ? { zip: address.zip } : {}),
              },
            },
          })
        ).orderUpdate!,
    );
    if (done) setEditing(false);
  };

  if (editing) {
    return (
      <form onSubmit={(form) => void submit(form)} className="flex flex-col gap-3">
        <TextField label={t('details.address.name')} value={fields.name} onChange={set('name')} />
        <TextField
          label={t('details.address.phone')}
          ltr
          inputMode="tel"
          value={fields.phone}
          onChange={set('phone')}
        />
        <TextField
          label={t('details.address.address1')}
          value={fields.address1}
          onChange={set('address1')}
        />
        <TextField
          label={t('details.address.address2')}
          value={fields.address2}
          onChange={set('address2')}
        />
        <TextField
          label={t('details.address.landmark')}
          hint={t('details.address.landmarkHint')}
          value={fields.landmark}
          onChange={set('landmark')}
        />
        <div className="grid gap-3 md:grid-cols-2">
          <TextField label={t('details.address.city')} value={fields.city} onChange={set('city')} />
          <TextField
            label={t('details.address.province')}
            hint={t('details.address.provinceHint')}
            value={fields.province}
            onChange={set('province')}
          />
        </div>
        {problem && <Alert tone="danger">{problem}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={update.isPending} disabled={!ready}>
            {t('details.save')}
          </Button>
          <Button variant="tertiary" onClick={() => setEditing(false)}>
            {t('returns.cancel')}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <address className="not-italic">
        {address.formatted.map((line, index) => (
          <div key={index} dir="auto">
            {line}
          </div>
        ))}
      </address>
      {correctable && (
        <Button
          variant="tertiary"
          className="self-start"
          onClick={() => {
            setFields(blank());
            setEditing(true);
          }}
        >
          {t('details.address.correct')}
        </Button>
      )}
    </div>
  );
}
