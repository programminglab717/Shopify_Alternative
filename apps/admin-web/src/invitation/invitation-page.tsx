import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { authRequest, browserFetch } from '../api/client';
import type { StaffMemberRole } from '../api/types';
import { AuthLayout } from '../auth/auth-layout';
import { ME_KEY, useSession, useSessionStore } from '../auth/context';
import type { ShopAccess } from '../auth/session';
import { errorText } from '../i18n/errors';
import { formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { roleLabel } from '../settings/settings-page';
import { Button } from '../ui/button';
import { Alert, Loading } from '../ui/feedback';

/** Where an invitation's token waits while its person signs in or opens an account. */
const PENDING = 'hatti.invitation';

/** The token of an invitation its person opened before signing in, if any; read once. */
export function takePendingInvitation(): string | null {
  try {
    const token = window.sessionStorage.getItem(PENDING);
    window.sessionStorage.removeItem(PENDING);
    return token;
  } catch {
    return null;
  }
}

function tokenOf(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token');
}

interface Preview {
  shop: { name: string };
  role: string;
  invitedBy: string;
  expiresAt: string;
}

/**
 * The page an invitation's link opens (ADR-101): who invited the person to which shop and in
 * what role; accepted once they are signed in, after which the shop opens. The token stays after
 * the `#`, never sent in the address, and waits in the tab while they sign in or sign up.
 */
export function InvitationPage() {
  const { t, locale } = useLocale();
  const { signedIn } = useSession();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [token] = useState(() => tokenOf(window.location.hash));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setProblem(t('invitation.noToken'));
      return;
    }
    let live = true;
    authRequest<{ invitation: Preview }>(browserFetch, '/auth/invitations/preview', {
      body: { token },
    })
      .then((answer) => live && setPreview(answer.invitation))
      .catch((failure: unknown) => live && setProblem(errorText(failure, t)));
    return () => {
      live = false;
    };
  }, [token, t]);

  const keepForLater = () => {
    try {
      if (token) window.sessionStorage.setItem(PENDING, token);
    } catch {
      // Without storage they open the link again once signed in.
    }
  };

  const onAccept = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { shop } = await store.auth<{ shop: ShopAccess }>('/auth/invitations/accept', {
        body: { token },
      });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      await navigate({ to: '/$shopId', params: { shopId: shop.id }, replace: true });
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('invitation.title')}>
      <div className="flex flex-col gap-4">
        {!preview && !problem && <Loading label={t('state.loading')} />}
        {preview && (
          <>
            <p>
              {t('invitation.body', {
                inviter: preview.invitedBy,
                shop: preview.shop.name,
                role: t(roleLabel(preview.role.toUpperCase() as StaffMemberRole)),
              })}
            </p>
            <p className="text-secondary">
              {t('invitation.expires', {
                when: formatRelative(preview.expiresAt, 'Asia/Karachi', locale),
              })}
            </p>
            {signedIn ? (
              <Button busy={busy} onClick={() => void onAccept()}>
                {t('invitation.accept', { shop: preview.shop.name })}
              </Button>
            ) : (
              <div className="flex flex-col gap-2">
                <Link
                  to="/sign-in"
                  onClick={keepForLater}
                  className="inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-4 font-medium text-on-primary"
                >
                  {t('invitation.signIn')}
                </Link>
                <Link
                  to="/sign-up"
                  onClick={keepForLater}
                  className="inline-flex min-h-12 items-center justify-center rounded-control border border-line px-4 font-medium"
                >
                  {t('invitation.signUp')}
                </Link>
              </div>
            )}
          </>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
      </div>
    </AuthLayout>
  );
}
