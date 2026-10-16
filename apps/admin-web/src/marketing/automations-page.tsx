import { Link } from '@tanstack/react-router';
import { CircleCheck, CirclePause, Save, Workflow } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { MarketingAutomationsQuery, MarketingAutomationUpdateMutation } from '../api/operations';
import type {
  AutomationTemplate,
  MarketingAutomation,
  MarketingAutomationKind,
  MarketingAutomationsData,
  MarketingAutomationUpdateData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { CheckField, parseWhole, SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { BackToMarketing, NoNumberHint } from './templates-page';

/** Recipes that send Hatti's own template from its number, choosing none of the shop's (ADR-429). */
const FROM_HATTI: readonly MarketingAutomationKind[] = ['BACK_IN_STOCK'];

/** The days a win-back may wait after the customer's last order (ADR-425). */
const WIN_BACK_DAYS = { min: 14, max: 365 } as const;

/** A template's name in a choice: its language, and what Meta made of it unless approved. */
function templateLabel(template: AutomationTemplate, t: (key: MessageKey) => string): string {
  const name = `${template.name} (${template.language.toLowerCase()})`;
  return template.status === 'APPROVED'
    ? name
    : `${name} · ${t(`templates.status.${template.status}` as MessageKey)}`;
}

/** One recipe: on or off, the template it sends, and for a win-back its days. */
function Recipe({
  automation,
  templates,
}: {
  automation: MarketingAutomation;
  templates: readonly AutomationTemplate[];
}) {
  const { t } = useLocale();
  const update = useAdminMutation<
    MarketingAutomationUpdateData,
    {
      kind: MarketingAutomationKind;
      input: { enabled: boolean; templateId?: string | null; afterDays?: number | null };
    }
  >(MarketingAutomationUpdateMutation);
  const winBack = automation.kind === 'WIN_BACK';
  const hatti = FROM_HATTI.includes(automation.kind);
  const [enabled, setEnabled] = useState(automation.enabled);
  const [templateId, setTemplateId] = useState(automation.template?.id ?? '');
  const [days, setDays] = useState(String(automation.afterDays ?? ''));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The approved templates, and the one chosen whatever Meta made of it since.
  const choices = templates.filter(
    (template) => template.status === 'APPROVED' || template.id === automation.template?.id,
  );
  const changed =
    enabled !== automation.enabled ||
    templateId !== (automation.template?.id ?? '') ||
    (winBack && days.trim() !== String(automation.afterDays ?? ''));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setProblem(null);
    setSaved(false);
    let afterDays: number | null | undefined;
    if (winBack) {
      afterDays = parseWhole(days);
      if (
        afterDays === null ||
        Number.isNaN(afterDays) ||
        afterDays < WIN_BACK_DAYS.min ||
        afterDays > WIN_BACK_DAYS.max
      ) {
        setProblem(t('automations.badDays', WIN_BACK_DAYS));
        return;
      }
    }
    try {
      const { marketingAutomationUpdate } = await update.mutateAsync({
        kind: automation.kind,
        input: {
          enabled,
          ...(!hatti && { templateId: templateId || null }),
          ...(winBack && { afterDays }),
        },
      });
      const error = marketingAutomationUpdate.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return;
      }
      setSaved(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <span className="flex min-w-0 flex-col">
            <h2 className="font-semibold">{t(`automations.${automation.kind}` as MessageKey)}</h2>
            <span className="text-secondary">
              {t(`automations.${automation.kind}.hint` as MessageKey)}
            </span>
          </span>
          {automation.enabled ? (
            <Badge colour="delivered" icon={CircleCheck} label={t('automations.isOn')} />
          ) : (
            <Badge colour="returned" icon={CirclePause} label={t('automations.isOff')} />
          )}
        </div>
        {hatti ? (
          <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('automations.fromHatti')}
          </p>
        ) : (
          <SelectField<string>
            label={t('automations.template')}
            value={templateId}
            options={[
              { value: '', label: t('automations.chooseTemplate') },
              ...choices.map((template) => ({
                value: template.id,
                label: templateLabel(template, t),
              })),
            ]}
            onChange={setTemplateId}
          />
        )}
        {winBack && (
          <TextField
            label={t('automations.afterDays')}
            hint={t('automations.afterDaysHint', WIN_BACK_DAYS)}
            inputMode="numeric"
            ltr
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
        )}
        <CheckField label={t('automations.on')} checked={enabled} onChange={setEnabled} />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && <Alert tone="success">{t('automations.saved')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={update.isPending}
          disabled={!changed}
          icon={<Save aria-hidden className="size-5" />}
        >
          {t('automations.save')}
        </Button>
      </form>
    </Card>
  );
}

/**
 * Marketing's automations (MKT-04, ADR-428): a welcome to a customer who agrees to hear from the
 * shop on WhatsApp, and a win-back some days after a customer's last order, each sending one of
 * the shop's approved templates from its own number once turned on; and back in stock, which
 * tells shoppers who asked when a sold-out variant sells again, from Hatti's number (ADR-430).
 */
export function AutomationsPage() {
  const { t } = useLocale();
  const shopId = useShop().id;
  const query = useAdminQuery<MarketingAutomationsData>(
    ['marketingAutomations'],
    MarketingAutomationsQuery,
  );
  const approved = query.data?.whatsAppTemplates.some((template) => template.status === 'APPROVED');

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToMarketing />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Workflow aria-hidden className="size-7 text-secondary" />
        {t('automations.title')}
      </h1>
      <p className="text-secondary">{t('automations.intro')}</p>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : (
        <>
          {!approved && (
            <Alert tone="info">
              {t('automations.noTemplate')}{' '}
              {query.data.whatsAppTemplates.length === 0 ? (
                <NoNumberHint />
              ) : (
                <Link
                  to="/$shopId/marketing/templates"
                  params={{ shopId }}
                  className="font-medium text-primary hover:underline"
                >
                  {t('templates.title')}
                </Link>
              )}
            </Alert>
          )}
          {query.data.marketingAutomations.map((automation) => (
            <Recipe
              key={`${automation.kind}:${automation.updatedAt ?? ''}`}
              automation={automation}
              templates={query.data.whatsAppTemplates}
            />
          ))}
        </>
      )}
    </div>
  );
}
