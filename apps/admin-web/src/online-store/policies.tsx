import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, CircleCheck, CircleDashed, FileText, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  PoliciesQuery,
  PolicyDraftQuery,
  PolicyTranslationQuery,
  PolicyUpdateMutation,
  TranslationsRegisterMutation,
} from '../api/operations';
import type {
  PoliciesData,
  PolicyDraftData,
  PolicyTranslationData,
  ShopPolicy,
  ShopPolicyType,
  UserError,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { BodyArea, normalized, useBody } from './body-field';

/** Those who set the shop's legal policies (`write_legal_policies`): owners and managers. */
export const SETS_POLICIES: readonly StaffRole[] = ['owner', 'manager'];

/** The policies a shop keeps, in Shopify's order. */
export const POLICY_TYPES: readonly ShopPolicyType[] = [
  'REFUND_POLICY',
  'SHIPPING_POLICY',
  'PRIVACY_POLICY',
  'TERMS_OF_SERVICE',
  'CONTACT_INFORMATION',
];

/** A policy type as its address names it. */
const slug = (type: ShopPolicyType) => type.toLowerCase().replace(/_/g, '-');
const typeOf = (value: string) => POLICY_TYPES.find((type) => slug(type) === value);

type Mutated = Record<string, { userErrors: UserError[] }>;

/** The shop's five policies, each written or not, a tap from its page. */
export function PoliciesList() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const query = useAdminQuery<PoliciesData>(['policies'], PoliciesQuery);
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const kept = new Map(query.data.shop.shopPolicies.map((policy) => [policy.type, policy]));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-secondary">{t('policies.intro')}</p>
      <Card>
        <ul className="divide-y divide-line">
          {POLICY_TYPES.map((type) => {
            const written = kept.has(type);
            return (
              <li key={type}>
                <Link
                  to="/$shopId/online-store/policies/$policy"
                  params={{ shopId, policy: slug(type) }}
                  className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 hover:bg-canvas"
                >
                  <span className="flex items-center gap-2 font-medium">
                    <FileText aria-hidden className="size-5 text-secondary" />
                    {t(`policies.type.${type}` as MessageKey)}
                  </span>
                  <Badge
                    colour={written ? 'delivered' : 'needsConfirmation'}
                    icon={written ? CircleCheck : CircleDashed}
                    label={t(written ? 'policies.written' : 'policies.notWritten')}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

/** Hatti's draft of a policy, asked for when wanted: it reads the shop's settings now. */
function useDraft(type: ShopPolicyType) {
  const shop = useShop();
  const store = useSessionStore();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { t } = useLocale();
  const fetch = async (locale: 'en' | 'ur'): Promise<string | null> => {
    setBusy(true);
    setProblem(null);
    try {
      const data = await store.graphql<PolicyDraftData>(shop.id, PolicyDraftQuery, {
        type,
        locale,
      });
      return data.shopPolicyDraft.body;
    } catch (failure) {
      setProblem(errorText(failure, t));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { fetch, busy, problem };
}

/** The policy in the shop's own words: started from Hatti's draft, saved, or taken away. */
function OwnWords({ type, policy }: { type: ShopPolicyType; policy: ShopPolicy | null }) {
  const { t } = useLocale();
  const update = useAdminMutation<Mutated, { shopPolicy: { type: ShopPolicyType; body: string } }>(
    PolicyUpdateMutation,
  );
  const { problem, attempt } = useAttempt();
  const draft = useDraft(type);
  const body = useBody(policy?.body ?? '');
  const [saved, setSaved] = useState(false);
  const [asking, setAsking] = useState(false);
  const changed = body.html !== normalized(policy?.body ?? '');
  const save = async (html: string) => {
    setSaved(false);
    const ok = await attempt(
      async () => Object.values(await update.mutateAsync({ shopPolicy: { type, body: html } }))[0]!,
    );
    setSaved(ok);
    return ok;
  };
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (changed && body.html.trim() !== '') await save(body.html);
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <FormSection title={t('policies.ownWords')} hint={t('policies.notAdvice')}>
        {body.value.trim() === '' && (
          <Button
            variant="secondary"
            className="self-start"
            busy={draft.busy}
            onClick={() =>
              void draft.fetch('en').then((html) => {
                if (html !== null) body.load(html);
              })
            }
          >
            {t('policies.startDraft')}
          </Button>
        )}
        {draft.problem && <Alert tone="danger">{draft.problem}</Alert>}
        <BodyArea body={body} label={t('policies.body')} />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && <Alert tone="success">{t('policies.saved')}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            busy={update.isPending && !asking}
            disabled={!changed || body.html.trim() === ''}
          >
            {t('policies.save')}
          </Button>
          {policy && !asking && (
            <Button
              variant="danger"
              icon={<Trash2 aria-hidden className="size-5" />}
              onClick={() => setAsking(true)}
            >
              {t('policies.remove')}
            </Button>
          )}
        </div>
        {policy && asking && (
          <div className="flex flex-col gap-3 rounded-card border border-line p-4">
            <p>{t('policies.removeAsk')}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                busy={update.isPending}
                onClick={() =>
                  void save('').then((ok) => {
                    if (ok) {
                      body.load('');
                      setAsking(false);
                    }
                  })
                }
              >
                {t('policies.removeConfirm')}
              </Button>
              <Button variant="tertiary" onClick={() => setAsking(false)}>
                {t('returns.cancel')}
              </Button>
            </div>
          </div>
        )}
      </FormSection>
    </form>
  );
}

/**
 * The policy in Urdu, kept as a translation of the shop's own words (OS-06): started from Hatti's
 * Urdu draft, and said to be out of date once those words change.
 */
function InUrdu({ type, policy }: { type: ShopPolicyType; policy: ShopPolicy }) {
  const { t } = useLocale();
  const query = useAdminQuery<PolicyTranslationData>(
    ['policyTranslation', policy.id],
    PolicyTranslationQuery,
    { id: policy.id },
  );
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const resource = query.data.translatableResource;
  const digest = resource?.translatableContent.find((each) => each.key === 'body')?.digest;
  if (!resource || !digest) return null;
  const kept = resource.translations.find((each) => each.key === 'body') ?? null;
  return (
    <UrduForm
      // A new digest, once the shop's own words change, starts the form again.
      key={digest}
      type={type}
      resourceId={resource.resourceId}
      digest={digest}
      kept={kept}
    />
  );
}

function UrduForm({
  type,
  resourceId,
  digest,
  kept,
}: {
  type: ShopPolicyType;
  resourceId: string;
  digest: string;
  kept: { value: string | null; outdated: boolean } | null;
}) {
  const { t } = useLocale();
  const register = useAdminMutation<
    Mutated,
    { resourceId: string; translations: Record<string, unknown>[] }
  >(TranslationsRegisterMutation);
  const { problem, attempt } = useAttempt();
  const draft = useDraft(type);
  const body = useBody(kept?.value ?? '', true);
  const [saved, setSaved] = useState(false);
  const changed = body.html !== normalized(kept?.value ?? '', true);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || body.html.trim() === '') return;
    setSaved(false);
    const ok = await attempt(
      async () =>
        Object.values(
          await register.mutateAsync({
            resourceId,
            translations: [
              { key: 'body', locale: 'ur', translatableContentDigest: digest, value: body.html },
            ],
          }),
        )[0]!,
    );
    setSaved(ok);
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <FormSection title={t('policies.urdu')} hint={t('policies.urduHint')}>
        {kept?.outdated && <Alert tone="warning">{t('policies.urduOutdated')}</Alert>}
        {body.value.trim() === '' && (
          <Button
            variant="secondary"
            className="self-start"
            busy={draft.busy}
            onClick={() =>
              void draft.fetch('ur').then((html) => {
                if (html !== null) body.load(html);
              })
            }
          >
            {t('policies.startUrduDraft')}
          </Button>
        )}
        {draft.problem && <Alert tone="danger">{draft.problem}</Alert>}
        <BodyArea body={body} label={t('policies.urduBody')} />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && <Alert tone="success">{t('policies.saved')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={register.isPending}
          disabled={!changed || body.html.trim() === ''}
        >
          {t('policies.saveUrdu')}
        </Button>
      </FormSection>
    </form>
  );
}

/**
 * One of the shop's policies (ONB-09): its own words, started from Hatti's draft filled in from
 * the shop's settings, and its Urdu; owners and managers.
 */
export function PolicyPage() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  const { policy: param } = useParams({ from: '/$shopId/online-store/policies/$policy' });
  const type = typeOf(param);
  const query = useAdminQuery<PoliciesData>(['policies'], PoliciesQuery);
  const back = (
    <Link
      to="/$shopId/online-store"
      params={{ shopId }}
      search={{ tab: 'policies' }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('policies.back')}
    </Link>
  );
  if (!SETS_POLICIES.includes(role)) return <EmptyState title={t('policies.cannot')} />;
  if (!type) return <EmptyState title={t('policies.notFound')} />;
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const policy = query.data.shop.shopPolicies.find((each) => each.type === type) ?? null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      {back}
      <div className="flex flex-col gap-1">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t(`policies.type.${type}` as MessageKey)}
        </h1>
        <p className="text-secondary" dir="ltr">
          /policies/{slug(type)}
        </p>
      </div>
      <OwnWords key={type} type={type} policy={policy} />
      {policy && <InUrdu type={type} policy={policy} />}
    </div>
  );
}
