import { Copy, MessageCircle, Trash2, UserPlus } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  StaffInvitationCreateMutation,
  StaffInvitationRevokeMutation,
  StaffMemberRemoveMutation,
  StaffMemberRoleUpdateMutation,
  StaffQuery,
} from '../api/operations';
import type {
  StaffData,
  StaffInvitation,
  StaffInvitationCreateData,
  StaffMember,
  StaffMemberRole,
  UserError,
} from '../api/types';
import { useMe } from '../auth/context';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { formatDate, formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { apiRole, BackToSettings, roleLabel } from './settings-page';

/** Roles from the most to the least power over the shop. */
const ROLES: readonly StaffMemberRole[] = [
  'OWNER',
  'MANAGER',
  'CONFIRMATION_AGENT',
  'PACKER',
  'MARKETER',
  'ACCOUNTANT',
];

/** The roles a member gives and takes: the owner any but its own, managers those below them. */
export function rolesManagedBy(role: StaffMemberRole): StaffMemberRole[] {
  if (role === 'OWNER') return ROLES.filter((each) => each !== 'OWNER');
  if (role === 'MANAGER') return ROLES.filter((each) => each !== 'OWNER' && each !== 'MANAGER');
  return [];
}

/** The link an invitation opens: the admin's page for it, the token after the `#`. */
export function invitationLink(token: string): string {
  return `${window.location.origin}/invitation#token=${token}`;
}

function failedWith(errors: UserError[], t: Parameters<typeof problemText>[1]): string | null {
  return errors[0] ? problemText(errors[0], t) : null;
}

/** The invitation just made: its link to send, and whether Hatti emailed it too. */
function Invited({ token, emailed }: { token: string; emailed: string | null }) {
  const { t } = useLocale();
  const shop = useShop();
  const [copied, setCopied] = useState(false);
  const link = invitationLink(token);
  const message = t('staff.inviteMessage', { shop: shop.name, link });
  return (
    <Alert tone="success">
      <div className="flex flex-col gap-2">
        <p>{emailed ? t('staff.invitedEmailed', { email: emailed }) : t('staff.invited')}</p>
        <code
          dir="ltr"
          className="num block overflow-x-auto rounded-control bg-surface p-2 text-[length:var(--hatti-type-body-sm-size)]"
        >
          {link}
        </code>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<Copy aria-hidden className="size-5" />}
            onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}
          >
            {copied ? t('staff.copied') : t('staff.copy')}
          </Button>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(message)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium md:min-h-10"
          >
            <MessageCircle aria-hidden className="size-5" />
            {t('staff.sendOnWhatsApp')}
          </a>
        </div>
      </div>
    </Alert>
  );
}

/**
 * Staff (ADR-101): who works in the shop and in what role, changed or let go by those who manage
 * it; and invitations, sent as a link to share on WhatsApp or emailed, taken back while open.
 * The core asks the member to confirm who they are first when they signed in a while ago.
 */
export function StaffPage() {
  const { t, locale } = useLocale();
  const shop = useShop();
  const timezone = useShopTimezone();
  const me = useMe();
  const query = useAdminQuery<StaffData>(['staff'], StaffQuery);
  const { run, panel } = useRecentAuthentication();
  const invite = useAdminMutation<
    StaffInvitationCreateData,
    { role: StaffMemberRole; note: string | null; email: string | null; language: 'EN' | 'UR' }
  >(StaffInvitationCreateMutation);
  const revoke = useAdminMutation<
    { staffInvitationRevoke: { userErrors: UserError[] } },
    { id: string }
  >(StaffInvitationRevokeMutation);
  const changeRole = useAdminMutation<
    { staffMemberRoleUpdate: { userErrors: UserError[] } },
    { id: string; role: StaffMemberRole }
  >(StaffMemberRoleUpdateMutation);
  const remove = useAdminMutation<
    { staffMemberRemove: { userErrors: UserError[] } },
    { id: string }
  >(StaffMemberRemoveMutation);
  const managed = rolesManagedBy(apiRole(shop.role));
  const [role, setRole] = useState<StaffMemberRole>(managed.at(-1) ?? 'PACKER');
  const roleField = useId();
  const [note, setNote] = useState('');
  const [email, setEmail] = useState('');
  const [invited, setInvited] = useState<{ token: string; emailed: string | null } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const onError = (failure: unknown) => setProblem(errorText(failure, t));

  const onInvite = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setInvited(null);
    void run(async () => {
      const { staffInvitationCreate } = await invite.mutateAsync({
        role,
        note: note.trim() || null,
        email: email.trim() || null,
        language: locale === 'ur' ? 'UR' : 'EN',
      });
      const failed = failedWith(staffInvitationCreate.userErrors, t);
      if (failed) setProblem(failed);
      else if (staffInvitationCreate.token) {
        setInvited({
          token: staffInvitationCreate.token,
          emailed: staffInvitationCreate.emailed ? email.trim() : null,
        });
        setNote('');
        setEmail('');
      }
    }, onError);
  };

  const onRole = (member: StaffMember, next: StaffMemberRole) => {
    setProblem(null);
    void run(async () => {
      const { staffMemberRoleUpdate } = await changeRole.mutateAsync({ id: member.id, role: next });
      setProblem(failedWith(staffMemberRoleUpdate.userErrors, t));
    }, onError);
  };

  const onRemove = (member: StaffMember) => {
    setProblem(null);
    void run(async () => {
      const { staffMemberRemove } = await remove.mutateAsync({ id: member.id });
      setProblem(failedWith(staffMemberRemove.userErrors, t));
      setRemoving(null);
    }, onError);
  };

  const onRevoke = (invitation: StaffInvitation) => {
    setProblem(null);
    void run(async () => {
      const { staffInvitationRevoke } = await revoke.mutateAsync({ id: invitation.id });
      setProblem(failedWith(staffInvitationRevoke.userErrors, t));
    }, onError);
  };

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { staffMembers: members, staffInvitations: invitations } = query.data;
  const myId = me.data?.user.id;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.staff')}
      </h1>
      {panel}
      {problem && <Alert tone="danger">{problem}</Alert>}

      <Card>
        <ul className="divide-y divide-line">
          {members.map((member) => {
            const mine = member.id === myId;
            const changeable = !mine && managed.includes(member.role);
            return (
              <li key={member.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium" dir="auto">
                    {member.name}
                    {mine && <span className="text-secondary"> · {t('staff.you')}</span>}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-secondary">{member.email}</span>
                  {changeable ? (
                    <select
                      value={member.role}
                      aria-label={t('staff.roleOf', { name: member.name })}
                      disabled={changeRole.isPending}
                      onChange={(event) => onRole(member, event.target.value as StaffMemberRole)}
                      className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
                    >
                      {managed.map((each) => (
                        <option key={each} value={each}>
                          {t(roleLabel(each))}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-secondary">{t(roleLabel(member.role))}</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t('staff.joined', { date: formatDate(member.joinedAt, timezone, locale) })}
                  {changeable &&
                    (removing === member.id ? (
                      <>
                        <span>{t('staff.removeSure', { name: member.name })}</span>
                        <Button
                          variant="destructive"
                          busy={remove.isPending}
                          onClick={() => onRemove(member)}
                        >
                          {t('staff.removeYes')}
                        </Button>
                        <Button variant="tertiary" onClick={() => setRemoving(null)}>
                          {t('action.back')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="tertiary"
                        className="text-danger"
                        icon={<Trash2 aria-hidden className="size-5" />}
                        aria-label={t('staff.remove', { name: member.name })}
                        onClick={() => setRemoving(member.id)}
                      />
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {invitations.length > 0 && (
        <section aria-labelledby="staff-invitations" className="flex flex-col gap-2">
          <h2 id="staff-invitations" className="font-semibold">
            {t('staff.invitations')}
          </h2>
          <Card>
            <ul className="divide-y divide-line">
              {invitations.map((invitation) => (
                <li key={invitation.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium" dir="auto">
                      {invitation.note || invitation.email || t(roleLabel(invitation.role))}
                    </span>
                    <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                      {t(roleLabel(invitation.role))} ·{' '}
                      {t('staff.expires', {
                        when: formatRelative(invitation.expiresAt, timezone, locale),
                      })}
                    </span>
                  </span>
                  <Button
                    variant="tertiary"
                    disabled={revoke.isPending}
                    onClick={() => onRevoke(invitation)}
                  >
                    {t('staff.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {managed.length > 0 && (
        <Card className="p-4">
          <form onSubmit={onInvite} className="flex flex-col gap-4">
            <h2 className="inline-flex items-center gap-2 font-semibold">
              <UserPlus aria-hidden className="size-5" />
              {t('staff.invite')}
            </h2>
            <div className="flex flex-col gap-1">
              <label htmlFor={roleField} className="font-medium">
                {t('staff.role')}
              </label>
              <select
                id={roleField}
                value={role}
                onChange={(event) => setRole(event.target.value as StaffMemberRole)}
                className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
              >
                {managed.map((each) => (
                  <option key={each} value={each}>
                    {t(roleLabel(each))}
                  </option>
                ))}
              </select>
              <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {t(`role.${role}.hint` as Parameters<typeof t>[0])}
              </span>
            </div>
            <TextField
              label={t('staff.note')}
              hint={t('staff.noteHint')}
              maxLength={100}
              dir="auto"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <TextField
              label={t('staff.email')}
              hint={t('staff.emailHint')}
              type="email"
              ltr
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button type="submit" busy={invite.isPending} className="self-start">
              {t('staff.inviteSubmit')}
            </Button>
          </form>
        </Card>
      )}
      {invited && <Invited token={invited.token} emailed={invited.emailed} />}
    </div>
  );
}
