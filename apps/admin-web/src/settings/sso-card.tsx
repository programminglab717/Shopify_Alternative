import { Building2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ShopSsoDeleteMutation,
  ShopSsoDomainsCheckMutation,
  ShopSsoQuery,
  ShopSsoUpdateMutation,
} from '../api/operations';
import type {
  ShopSso,
  ShopSsoData,
  ShopSsoDomainsCheckData,
  ShopSsoUpdateData,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CheckField } from './settings-form';

interface Form {
  issuer: string;
  clientId: string;
  clientSecret: string;
  domains: string;
  required: boolean;
  providerMfa: boolean;
}

const formOf = (sso: ShopSso | null): Form => ({
  issuer: sso?.issuer ?? '',
  clientId: sso?.clientId ?? '',
  clientSecret: '',
  domains: sso?.emailDomains.join(', ') ?? '',
  required: sso?.required ?? false,
  providerMfa: sso?.providerMfa ?? true,
});

/**
 * The shop's single sign-on, for its owner (ADM-09, ADR-864): the organisation's identity
 * provider, its staff's email domains, and whether the shop admits its staff only through it,
 * with the address to register at the provider. Saving asks the owner to confirm who they are.
 * Each domain is proved the shop's by a TXT record DNS shows (ADR-919).
 */
export function SsoCard() {
  const { t } = useLocale();
  const query = useAdminQuery<ShopSsoData>(['shopSso'], ShopSsoQuery);
  const save = useAdminMutation<ShopSsoUpdateData, { input: Record<string, unknown> }>(
    ShopSsoUpdateMutation,
  );
  const remove = useAdminMutation<{ shopSsoDelete: boolean }, Record<string, never>>(
    ShopSsoDeleteMutation,
  );
  const check = useAdminMutation<ShopSsoDomainsCheckData, Record<string, never>>(
    ShopSsoDomainsCheckMutation,
  );
  const [checked, setChecked] = useState<'none' | null>(null);
  const recent = useRecentAuthentication();
  const [form, setForm] = useState<Form | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  if (query.isPending) return <Loading label={t('state.loading')} />;
  const sso = query.data?.shopSso ?? null;
  const current = form ?? formOf(sso);
  const change = (patch: Partial<Form>) => {
    setSaved(false);
    setForm({ ...current, ...patch });
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    await recent.run(
      async () => {
        const done = (
          await save.mutateAsync({
            input: {
              issuer: current.issuer.trim(),
              clientId: current.clientId.trim(),
              clientSecret: current.clientSecret.trim() || null,
              emailDomains: current.domains.split(/[\s,]+/).filter(Boolean),
              required: current.required,
              providerMfa: current.providerMfa,
            },
          })
        ).shopSsoUpdate;
        if (done.userErrors[0]) {
          setProblem(problemText(done.userErrors[0], t));
        } else {
          setForm(null);
          setSaved(true);
        }
      },
      (failure) => setProblem(errorText(failure, t)),
    );
    setBusy(false);
  };

  const onCheck = async () => {
    setProblem(null);
    setChecked(null);
    try {
      const done = (await check.mutateAsync({})).shopSsoDomainsCheck;
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
      else if (done.sso?.domains.some((each) => !each.provedAt)) setChecked('none');
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const onRemove = () =>
    void recent.run(
      async () => {
        await remove.mutateAsync({});
        setForm(null);
      },
      (failure) => setProblem(errorText(failure, t)),
    );

  return (
    <section aria-labelledby="staff-sso" className="flex flex-col gap-2">
      <h2 id="staff-sso" className="flex items-center gap-2 font-semibold">
        <Building2 aria-hidden className="size-5 text-secondary" />
        {t('sso.settingsTitle')}
      </h2>
      <Card className="p-4">
        <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
          <p className="text-secondary">{t('sso.settingsHint')}</p>
          {sso && (
            <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('sso.callback')}{' '}
              <code className="break-all" dir="ltr">
                {sso.callbackUrl}
              </code>
            </p>
          )}
          <TextField
            label={t('sso.issuer')}
            hint={t('sso.issuerHint')}
            value={current.issuer}
            onChange={(event) => change({ issuer: event.target.value })}
            required
            ltr
          />
          <TextField
            label={t('sso.clientId')}
            value={current.clientId}
            onChange={(event) => change({ clientId: event.target.value })}
            required
            ltr
          />
          <TextField
            label={t('sso.clientSecret')}
            hint={sso ? t('sso.secretKept', { hint: sso.secretHint }) : undefined}
            type="password"
            value={current.clientSecret}
            onChange={(event) => change({ clientSecret: event.target.value })}
            autoComplete="off"
            ltr
          />
          <TextField
            label={t('sso.domains')}
            hint={t('sso.domainsHint')}
            value={current.domains}
            onChange={(event) => change({ domains: event.target.value })}
            required
            ltr
          />
          <CheckField
            label={t('sso.providerMfa')}
            hint={t('sso.providerMfaHint')}
            checked={current.providerMfa}
            onChange={(providerMfa) => change({ providerMfa })}
          />
          <CheckField
            label={t('sso.required')}
            hint={t('sso.requiredHint')}
            checked={current.required}
            onChange={(required) => change({ required })}
          />
          {problem && <Alert tone="danger">{problem}</Alert>}
          {saved && <Alert tone="success">{t('sso.saved')}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={busy}>
              {t('sso.save')}
            </Button>
            {sso && (
              <Button variant="danger" onClick={onRemove}>
                {t('sso.remove')}
              </Button>
            )}
          </div>
        </form>
      </Card>
      {sso && (
        <Card className="p-4 flex flex-col gap-3">
          <h3 className="font-semibold">{t('sso.proofTitle')}</h3>
          <p className="text-secondary">{t('sso.proofHint')}</p>
          <p>
            {t('sso.proofValue')}{' '}
            <code className="break-all" dir="ltr">
              {sso.proofRecord}
            </code>
          </p>
          <ul className="flex flex-col gap-1">
            {sso.domains.map((each) => (
              <li key={each.domain} className="flex flex-wrap items-center gap-2">
                <code className="break-all" dir="ltr">
                  {each.recordName}
                </code>
                <span className={each.provedAt ? 'text-success' : 'text-secondary'}>
                  {each.provedAt ? t('sso.proved') : t('sso.notProved')}
                </span>
              </li>
            ))}
          </ul>
          {checked === 'none' && <Alert tone="info">{t('sso.checkedNone')}</Alert>}
          {sso.domains.some((each) => !each.provedAt) && (
            <div>
              <Button variant="secondary" busy={check.isPending} onClick={() => void onCheck()}>
                {t('sso.check')}
              </Button>
            </div>
          )}
        </Card>
      )}
      {recent.panel}
    </section>
  );
}
