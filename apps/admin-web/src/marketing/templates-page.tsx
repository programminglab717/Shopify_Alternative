import { Link } from '@tanstack/react-router';
import {
  ChevronRight,
  CircleCheck,
  CircleSlash,
  Clock,
  FileText,
  Pause,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  WhatsAppTemplateCreateMutation,
  WhatsAppTemplateDeleteMutation,
  WhatsAppTemplatesQuery,
  WhatsAppTemplatesSyncMutation,
} from '../api/operations';
import type {
  MessageLanguage,
  WhatsAppTemplate,
  WhatsAppTemplateCreateData,
  WhatsAppTemplateDeleteData,
  WhatsAppTemplateInput,
  WhatsAppTemplatesData,
  WhatsAppTemplatesSyncData,
  WhatsAppTemplateStatus,
} from '../api/types';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText, TextArea } from '../products/product-form';
import { SETS_SETTINGS } from '../settings/settings-page';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

const BADGES = {
  PENDING: { colour: 'needsConfirmation', icon: Clock },
  APPROVED: { colour: 'delivered', icon: CircleCheck },
  REJECTED: { colour: 'cancelled', icon: CircleSlash },
  PAUSED: { colour: 'deliveryIssue', icon: Pause },
  DISABLED: { colour: 'cancelled', icon: CircleSlash },
} as const satisfies Record<WhatsAppTemplateStatus, unknown>;

export const LANGUAGES: readonly MessageLanguage[] = ['EN', 'UR'];

/** A template's name as Meta takes it: small letters, digits and underscores. */
export function templateNameOf(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/** The way back to Marketing from one of its pages. */
export function BackToMarketing() {
  const { t } = useLocale();
  const shopId = useShop().id;
  return (
    <Link
      to="/$shopId/marketing"
      params={{ shopId }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ChevronRight aria-hidden className="size-5 rotate-180 rtl:rotate-0" />
      {t('nav.marketing')}
    </Link>
  );
}

/** Where a shop without a number connects one: settings, for those who change them. */
export function NoNumberHint() {
  const { t } = useLocale();
  const shop = useShop();
  return permits(shop, SETS_SETTINGS) ? (
    <Link
      to="/$shopId/settings/whatsapp"
      params={{ shopId: shop.id }}
      className="font-medium text-primary hover:underline"
    >
      {t('templates.connectNumber')}
    </Link>
  ) : (
    <p className="text-secondary">{t('templates.askOwner')}</p>
  );
}

const EMPTY = {
  name: '',
  language: 'EN' as MessageLanguage,
  header: '',
  body: '',
  footer: '',
  buttonText: '',
  buttonUrl: '',
};

/** A new template, sent to Meta to approve as the shop's marketing (ADR-420). */
function NewTemplate() {
  const { t } = useLocale();
  const create = useAdminMutation<WhatsAppTemplateCreateData, { input: WhatsAppTemplateInput }>(
    WhatsAppTemplateCreateMutation,
  );
  const [form, setForm] = useState(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const set = (field: keyof typeof EMPTY) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));
  const name = templateNameOf(form.name);
  const ready = name !== '' && form.body.trim() !== '';

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setProblem(null);
    setSent(false);
    const optional = (value: string) => value.trim() || null;
    try {
      const { whatsAppTemplateCreate } = await create.mutateAsync({
        input: {
          name,
          language: form.language,
          body: form.body.trim(),
          header: optional(form.header),
          footer: optional(form.footer),
          buttonText: optional(form.buttonText),
          buttonUrl: optional(form.buttonUrl),
        },
      });
      const error = whatsAppTemplateCreate.userErrors[0];
      if (error) {
        setProblem(problemText(error, t));
        return;
      }
      setForm(EMPTY);
      setSent(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <h2 className="font-medium">{t('templates.new')}</h2>
        <TextField
          label={t('templates.name')}
          hint={name ? t('templates.nameAs', { name }) : t('templates.nameHint')}
          value={form.name}
          ltr
          required
          maxLength={100}
          onChange={(event) => set('name')(event.target.value)}
        />
        <SelectField<MessageLanguage>
          label={t('templates.language')}
          value={form.language}
          options={LANGUAGES.map((value) => ({
            value,
            label: t(`templates.language.${value}` as MessageKey),
          }))}
          onChange={set('language')}
        />
        <TextField
          label={t('templates.header')}
          value={form.header}
          maxLength={60}
          dir="auto"
          onChange={(event) => set('header')(event.target.value)}
        />
        <TextArea label={t('templates.body')} value={form.body} onChange={set('body')} />
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('templates.bodyHint')}
        </p>
        <TextField
          label={t('templates.footer')}
          value={form.footer}
          maxLength={60}
          dir="auto"
          onChange={(event) => set('footer')(event.target.value)}
        />
        <TextField
          label={t('templates.buttonText')}
          value={form.buttonText}
          maxLength={25}
          dir="auto"
          onChange={(event) => set('buttonText')(event.target.value)}
        />
        <TextField
          label={t('templates.buttonUrl')}
          hint={t('templates.buttonUrlHint')}
          value={form.buttonUrl}
          type="url"
          ltr
          onChange={(event) => set('buttonUrl')(event.target.value)}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {sent && <Alert tone="success">{t('templates.sent')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={create.isPending}
          disabled={!ready}
          icon={<Send aria-hidden className="size-5" />}
        >
          {t('templates.send')}
        </Button>
      </form>
    </Card>
  );
}

/** One template: its name, language and words, what Meta made of it, and deleting it. */
function Template({ template }: { template: WhatsAppTemplate }) {
  const { t } = useLocale();
  const remove = useAdminMutation<WhatsAppTemplateDeleteData, { id: string }>(
    WhatsAppTemplateDeleteMutation,
  );
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const badge = BADGES[template.status];

  const onDelete = async () => {
    setProblem(null);
    try {
      const error = (await remove.mutateAsync({ id: template.id })).whatsAppTemplateDelete
        .userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
    setAsking(false);
  };

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="font-medium" dir="ltr">
            {template.name}
          </span>
          <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t(`templates.language.${template.language}` as MessageKey)}
          </span>
        </span>
        <Badge
          colour={badge.colour}
          icon={badge.icon}
          label={t(`templates.status.${template.status}` as MessageKey)}
        />
      </div>
      {template.header && (
        <p className="font-medium" dir="auto">
          {template.header}
        </p>
      )}
      <p className="whitespace-pre-line" dir="auto">
        {template.body}
      </p>
      {template.footer && (
        <p className="text-secondary" dir="auto">
          {template.footer}
        </p>
      )}
      {template.buttonText && (
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('templates.button', { text: template.buttonText, url: template.buttonUrl ?? '' })}
        </p>
      )}
      {template.rejectedReason && (
        <Alert tone="warning">{t('templates.why', { reason: template.rejectedReason })}</Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {asking ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>{t('templates.deleteSure', { name: template.name })}</span>
          <Button variant="destructive" busy={remove.isPending} onClick={() => void onDelete()}>
            {t('templates.deleteYes')}
          </Button>
          <Button variant="tertiary" onClick={() => setAsking(false)}>
            {t('action.back')}
          </Button>
        </div>
      ) : (
        <Button
          variant="danger"
          className="self-start"
          icon={<Trash2 aria-hidden className="size-5" />}
          aria-label={t('templates.delete', { name: template.name })}
          onClick={() => setAsking(true)}
        >
          {t('templates.deleteShort')}
        </Button>
      )}
    </Card>
  );
}

/**
 * The shop's own WhatsApp templates (MKT-01, ADR-420), which its broadcasts send: written and
 * sent to Meta to approve, what Meta made of each, asked again, and deleted.
 */
export function TemplatesPage() {
  const { t } = useLocale();
  const query = useAdminQuery<WhatsAppTemplatesData>(['whatsAppTemplates'], WhatsAppTemplatesQuery);
  const sync = useAdminMutation<WhatsAppTemplatesSyncData, Record<string, never>>(
    WhatsAppTemplatesSyncMutation,
  );
  const [problem, setProblem] = useState<string | null>(null);

  const onSync = async () => {
    setProblem(null);
    try {
      const error = (await sync.mutateAsync({})).whatsAppTemplatesSync.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToMarketing />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <FileText aria-hidden className="size-7 text-secondary" />
        {t('templates.title')}
      </h1>
      <p className="text-secondary">{t('templates.intro')}</p>
      <NewTemplate />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{t('templates.yours')}</h2>
        <Button
          variant="secondary"
          busy={sync.isPending}
          icon={<RefreshCw aria-hidden className="size-5" />}
          onClick={() => void onSync()}
        >
          {t('templates.sync')}
        </Button>
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.whatsAppTemplates.length === 0 ? (
        <EmptyState title={t('templates.none')} action={<NoNumberHint />} />
      ) : (
        <ul className="flex flex-col gap-3">
          {query.data.whatsAppTemplates.map((template) => (
            <li key={template.id}>
              <Template template={template} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
