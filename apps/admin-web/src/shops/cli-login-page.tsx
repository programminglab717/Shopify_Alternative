import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { CliLoginApproveMutation, CliLoginDenyMutation, CliLoginQuery } from '../api/operations';
import type {
  CliLoginAccess,
  CliLoginApproveData,
  CliLoginData,
  CliLoginDenyData,
} from '../api/types';
import { AuthLayout } from '../auth/auth-layout';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { useMe, useSession, useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { keepPendingLink } from './oauth-page';

/** The roles that let a terminal in, as they make the shop's apps. */
const APPROVERS = new Set(['owner', 'manager']);

/** A code as the terminal shows it, XXXX-XXXX, from what was linked or typed. */
export function cliCodeOf(text: string | null): string | null {
  const letters = (text ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^[B-DF-HJ-NP-TV-XZ]{8}$/.test(letters)
    ? `${letters.slice(0, 4)}-${letters.slice(4)}`
    : null;
}

/**
 * Where `hatti login` sends its person (DEV-08, ADR-990): `/cli-login?code=XXXX-XXXX`, or the code
 * typed. They check it is the one their terminal shows, choose the shop and whether the terminal
 * only reads or changes things too, and approve it, confirming who they are where they have not
 * lately; or refuse it. The terminal is let in as a custom app of the shop's, named for it.
 */
export function CliLoginPage() {
  const { t } = useLocale();
  const { signedIn } = useSession();
  const navigate = useNavigate();
  const [code, setCode] = useState(() =>
    cliCodeOf(new URLSearchParams(window.location.search).get('code')),
  );

  if (!signedIn) {
    return (
      <AuthLayout title={t('cliLogin.title')}>
        <p className="text-secondary">{t('cliLogin.signInFirst')}</p>
        <Button
          className="mt-4 self-start"
          onClick={() => {
            keepPendingLink(`/cli-login${window.location.search}`);
            void navigate({ to: '/sign-in' });
          }}
        >
          {t('oauth.signIn')}
        </Button>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={t('cliLogin.title')}>
      {code ? <Approve code={code} /> : <TypeCode onCode={setCode} />}
    </AuthLayout>
  );
}

function TypeCode({ onCode }: { onCode: (code: string) => void }) {
  const { t } = useLocale();
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState(false);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const code = cliCodeOf(typed);
    setProblem(!code);
    if (code) onCode(code);
  };
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <p className="text-secondary">{t('cliLogin.typeHint')}</p>
      <TextField
        label={t('cliLogin.code')}
        ltr
        autoComplete="off"
        autoCapitalize="characters"
        placeholder="XXXX-XXXX"
        value={typed}
        error={problem ? t('cliLogin.badCode') : undefined}
        onChange={(event) => setTyped(event.target.value)}
      />
      <Button type="submit" className="self-start">
        {t('cliLogin.next')}
      </Button>
    </form>
  );
}

type Answered = { kind: 'approved'; appName: string; shop: string } | { kind: 'denied' };

function Approve({ code }: { code: string }) {
  const { t } = useLocale();
  const store = useSessionStore();
  const me = useMe();
  const recent = useRecentAuthentication();
  const shops = (me.data?.shops ?? []).filter((shop) => APPROVERS.has(shop.role));
  const [chosen, setChosen] = useState<string | null>(null);
  const shop = shops.find((each) => each.id === chosen) ?? shops[0] ?? null;
  const login = useQuery({
    queryKey: ['cli-login', code, shop?.id ?? null],
    queryFn: () => store.graphql<CliLoginData>(shop!.id, CliLoginQuery, { code }),
    enabled: shop !== null,
    retry: false,
  });
  const [access, setAccess] = useState<CliLoginAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Answered | null>(null);

  if (me.isPending) return <Loading label={t('state.loading')} />;
  if (!shop) return <Alert tone="info">{t('cliLogin.noShop')}</Alert>;
  if (answered?.kind === 'approved') {
    return (
      <Alert tone="success">
        {t('cliLogin.approved', { shop: answered.shop, app: answered.appName })}
      </Alert>
    );
  }
  if (answered?.kind === 'denied') return <Alert tone="info">{t('cliLogin.denied')}</Alert>;
  if (login.isPending) return <Loading label={t('state.loading')} />;
  if (login.isError) return <ErrorState message={errorText(login.error, t)} />;
  const asked = login.data.cliLogin;
  if (!asked || asked.status !== 'PENDING') {
    return <Alert tone="warning">{t('cliLogin.gone')}</Alert>;
  }
  const given = access ?? asked.access;

  const onApprove = async () => {
    setBusy(true);
    setProblem(null);
    await recent.run(
      async () => {
        const { cliLoginApprove } = await store.graphql<CliLoginApproveData>(
          shop.id,
          CliLoginApproveMutation,
          { code, access: given },
          { idempotencyKey: crypto.randomUUID() },
        );
        const failed = cliLoginApprove.userErrors[0];
        if (failed) setProblem(problemText(failed, t));
        else setAnswered({ kind: 'approved', appName: cliLoginApprove.appName!, shop: shop.name });
      },
      (failure) => setProblem(errorText(failure, t)),
    );
    setBusy(false);
  };

  const onDeny = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await store.graphql<CliLoginDenyData>(shop.id, CliLoginDenyMutation, { code });
      setAnswered({ kind: 'denied' });
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-2 p-4">
        <span className="flex items-center gap-2 font-semibold" dir="auto">
          <SquareTerminal aria-hidden className="size-6 text-secondary" />
          {t('cliLogin.asks', { device: asked.device })}
        </span>
        <span className="text-secondary">{t('cliLogin.showsCode')}</span>
        <span
          className="font-mono text-2xl font-semibold tracking-widest"
          dir="ltr"
          aria-label={t('cliLogin.code')}
        >
          {asked.code}
        </span>
        {asked.requestedFrom && (
          <span className="text-secondary" dir="auto">
            {t('cliLogin.from', { address: asked.requestedFrom })}
          </span>
        )}
      </Card>
      <Alert tone="warning">{t('cliLogin.warning')}</Alert>
      <SelectField
        label={t('cliLogin.shop')}
        value={shop.id}
        options={shops.map((each) => ({ value: each.id, label: each.name }))}
        onChange={setChosen}
      />
      <SelectField<CliLoginAccess>
        label={t('cliLogin.access')}
        value={given}
        options={[
          { value: 'READ', label: t('cliLogin.read') },
          { value: 'WRITE', label: t('cliLogin.write') },
        ]}
        onChange={setAccess}
      />
      <p className="text-secondary">{t('cliLogin.accessHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Button busy={busy} onClick={() => void onApprove()}>
          {t('cliLogin.approve')}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void onDeny()}>
          {t('cliLogin.deny')}
        </Button>
        <Link to="/shops" className="inline-flex min-h-10 items-center text-secondary">
          {t('oauth.cancel')}
        </Link>
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {recent.panel}
    </div>
  );
}
