import type { OrderStage } from '@hatti/tokens';
import { CircleCheck, CircleDashed, Languages, PenLine, Save, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  InUrduQuery,
  TranslationsRegisterMutation,
  TranslationsRemoveMutation,
} from '../api/operations';
import type { InUrduData, UrduResource, UserError } from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { htmlFromText, textFromHtml } from '../online-store/page-body';
import { FormSection, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

/** Those who write the shop's Urdu (`write_translations`): owners, managers and marketers. */
export const WRITES_URDU: readonly StaffRole[] = ['owner', 'manager', 'marketer'];

/**
 * Something of the shop's whose words may be put in Urdu: a product, collection, page, blog,
 * article or menu, or the shop itself for its home page, with fields of its own; or a product's
 * option or one of its values, or a menu's link, with its name alone, `depth` levels in.
 */
export interface UrduThing {
  id: string;
  kind:
    | 'product'
    | 'collection'
    | 'page'
    | 'blog'
    | 'article'
    | 'menu'
    | 'shop'
    | 'option'
    | 'value'
    | 'link';
  depth?: number;
}

/** What is named by its own words alone, an option's say, and so labelled by them. */
const NAMED: ReadonlySet<UrduThing['kind']> = new Set(['option', 'value', 'link']);

/** Things of the shop's under a heading of their own, such as a product's options. */
export interface UrduSection {
  title: string;
  hint?: string;
  things: UrduThing[];
}

/** How a field's words are written: a line, a few lines, paragraphs, or a page's body. */
type Shape = 'line' | 'lines' | 'paragraphs' | 'body';

/** A field of the shop's own beside its Urdu, as kept. */
interface Field {
  id: string;
  resourceId: string;
  key: string;
  label: string;
  /** The shop's own words, as text to show; none where the label is them, as an option's. */
  own: string | null;
  digest: string;
  shape: Shape;
  /** Its Urdu as kept, as it is edited: text where plain text can hold it, else its HTML. */
  kept: string;
  keptAsHtml: boolean;
  /** Whether its Urdu was written for words of the shop's since changed. */
  outdated: boolean;
  /** How many levels in it is, as an option's value or a menu's link under another. */
  depth: number;
}

const LABELS: Readonly<Record<string, MessageKey>> = {
  title: 'urdu.field.title',
  body_html: 'urdu.field.description',
  summary_html: 'urdu.field.summary',
  product_type: 'urdu.field.productType',
  meta_title: 'urdu.field.metaTitle',
  meta_description: 'urdu.field.metaDescription',
};

/** A product's or collection's description is paragraphs; a page's or article's text, a body. */
function shapeOf(kind: UrduThing['kind'], key: string): Shape {
  if (key === 'body_html')
    return kind === 'product' || kind === 'collection' ? 'paragraphs' : 'body';
  if (key === 'summary_html') return 'body';
  return key === 'meta_description' ? 'lines' : 'line';
}

/** How far in a field is, by its depth. */
const DEPTHS = ['', 'ps-6', 'ps-12', 'ps-18'];

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * Paragraphs as the catalog keeps a description (ADR-238): one to each run of text between blank
 * lines, its line breaks kept.
 */
export function paragraphsHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map(
      (paragraph) =>
        `<p>${paragraph.replace(/[&<>]/g, (character) => ESCAPES[character]!).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

/** HTML's words alone, its blocks a blank line apart, to show. */
function wordsOf(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|ul|ol|div|blockquote)\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A field's words as they are edited: paragraphs and bodies as plain text where they can be. */
function editable(shape: Shape, value: string): { text: string; asHtml: boolean } {
  if (shape === 'line' || shape === 'lines') return { text: value, asHtml: false };
  const text = textFromHtml(value);
  if (text !== null) return { text, asHtml: false };
  return shape === 'body' ? { text: value, asHtml: true } : { text: wordsOf(value), asHtml: false };
}

/** A field's Urdu as the API takes it. */
function sent(field: Field, value: string): string {
  if (field.shape === 'paragraphs') return paragraphsHtml(value);
  if (field.shape === 'body') {
    return field.keptAsHtml && /<[a-z]/i.test(value) ? value : htmlFromText(value, { rtl: true });
  }
  return value.trim();
}

/** The fields of `things` with words of the shop's, in their order, with their Urdu. */
function fieldsOf(things: readonly UrduThing[], nodes: readonly UrduResource[], t: Translate) {
  const byId = new Map(nodes.map((node) => [node.resourceId, node]));
  return things.flatMap((thing): Field[] => {
    const node = byId.get(thing.id);
    if (!node) return [];
    const named = NAMED.has(thing.kind);
    return node.translatableContent.flatMap((content): Field[] => {
      if (!content.digest || !content.value) return [];
      const shape = shapeOf(thing.kind, content.key);
      const kept = node.translations.find((each) => each.key === content.key);
      const urdu = kept?.value ? editable(shape, kept.value) : { text: '', asHtml: false };
      const label = named
        ? content.value
        : shape === 'body' && content.key === 'body_html'
          ? t('urdu.field.body')
          : t(LABELS[content.key] ?? 'urdu.field.title');
      return [
        {
          id: `${node.resourceId} ${content.key}`,
          resourceId: node.resourceId,
          key: content.key,
          label,
          own: named ? null : shape === 'line' ? content.value : wordsOf(content.value),
          digest: content.digest,
          shape,
          kept: urdu.text,
          keptAsHtml: urdu.asHtml,
          outdated: kept?.outdated ?? false,
          depth: thing.depth ?? 0,
        },
      ];
    });
  });
}

/** How much of something's words is in Urdu. */
export interface UrduCount {
  total: number;
  written: number;
  /** Written for words of the shop's since changed. */
  outdated: number;
}

/** What a count says, as badges: none, some or all in Urdu, and how many to check. */
export function urduBadges(
  count: UrduCount,
  t: Translate,
): { colour: OrderStage; icon: LucideIcon; label: string }[] {
  const main: { colour: OrderStage; icon: LucideIcon; label: string } =
    count.written === 0
      ? { colour: 'cancelled', icon: CircleDashed, label: t('urdu.none') }
      : count.written === count.total
        ? { colour: 'delivered', icon: CircleCheck, label: t('urdu.all') }
        : {
            colour: 'confirmed',
            icon: Languages,
            label: t('urdu.some', { count: count.written, total: count.total }),
          };
  return count.outdated > 0
    ? [
        main,
        {
          colour: 'needsConfirmation',
          icon: TriangleAlert,
          label: t('urdu.toCheck', { count: count.outdated }),
        },
      ]
    : [main];
}

/** How much of `fields` is in Urdu: written, and written for words since changed. */
function countOf(fields: readonly Field[]): UrduCount {
  const written = fields.filter((field) => field.kept.trim() !== '');
  return {
    total: fields.length,
    written: written.length,
    outdated: written.filter((field) => field.outdated).length,
  };
}

/** What went wrong with a field's Urdu, under its label; words since changed said in ours. */
function problemOf(error: UserError, fields: readonly Field[], t: Translate): string {
  const at = error.field?.[0] === 'translations' ? Number(error.field[1]) : Number.NaN;
  const field = fields[at];
  if (!field) return problemText(error, t);
  if (error.code === 'STALE') return t('urdu.stale', { label: field.label });
  return `${field.label}: ${error.message}`;
}

/**
 * A field of the shop's own beside its Urdu (OS-06): its words for reference, the Urdu written
 * right to left in Urdu's own font, and, where the shop's words changed since, a word saying so.
 */
function UrduField({
  field,
  value,
  onChange,
  confirmed,
  onConfirm,
}: {
  field: Field;
  value: string;
  onChange: (value: string) => void;
  confirmed: boolean;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  const id = useId();
  const asHtml = field.keptAsHtml && /<[a-z]/i.test(value);
  const changed = value.trim() !== field.kept.trim();
  const box = {
    id,
    value,
    'aria-label': t('urdu.inUrdu', { label: field.label }),
    dir: asHtml ? 'ltr' : 'rtl',
    lang: asHtml ? undefined : 'ur',
    className: `rounded-control border border-line bg-surface px-3 text-text ${
      asHtml ? 'font-mono text-[length:var(--hatti-type-body-sm-size)]' : ''
    }`,
  } as const;
  return (
    <div className={`flex flex-col gap-1 ${DEPTHS[Math.min(field.depth, 3)]}`}>
      <label htmlFor={id} className="font-medium" dir="auto">
        {field.label}
      </label>
      {field.own !== null && (
        <p className="max-h-40 overflow-y-auto whitespace-pre-line text-secondary" dir="auto">
          {field.own}
        </p>
      )}
      {field.shape === 'line' ? (
        <input
          {...box}
          className={`${box.className} min-h-12 md:min-h-10`}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <textarea
          {...box}
          rows={field.shape === 'lines' ? 3 : 8}
          className={`${box.className} py-2`}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {field.shape === 'body' && (
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t(asHtml ? 'pages.bodyHtmlHint' : 'pages.bodyHint')}
        </p>
      )}
      {field.outdated && field.kept.trim() !== '' && !changed && (
        <div className="flex flex-wrap items-center gap-2 text-warning">
          <TriangleAlert aria-hidden className="size-5 shrink-0" />
          <span className="text-text">
            {t(confirmed ? 'urdu.keptAsItIs' : 'urdu.outdated', { label: field.label })}
          </span>
          {!confirmed && (
            <Button variant="tertiary" onClick={onConfirm}>
              {t('urdu.stillRight')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The words of `sections` in Urdu, each field of the shop's own beside its Urdu, saved together
 * as Shopify's translations are kept (ADR-238): one written or changed kept for the shop's words
 * as they are now, one emptied forgotten, the shop's own words then shown in its place.
 */
function UrduForm({
  sections,
  nodes,
  refetch,
}: {
  sections: readonly UrduSection[];
  nodes: readonly UrduResource[];
  refetch: () => Promise<unknown>;
}) {
  const { t } = useLocale();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const register = useAdminMutation<
    { translationsRegister: { userErrors: UserError[] } },
    { resourceId: string; translations: Record<string, string>[] }
  >(TranslationsRegisterMutation);
  const remove = useAdminMutation<
    { translationsRemove: { userErrors: UserError[] } },
    { resourceId: string; keys: string[] }
  >(TranslationsRemoveMutation);

  const groups = sections.map((section) => ({
    ...section,
    fields: fieldsOf(section.things, nodes, t),
  }));
  const fields = groups.flatMap((group) => group.fields);
  const valueOf = (field: Field) => edits[field.id] ?? field.kept;
  const changed = (field: Field) => valueOf(field).trim() !== field.kept.trim();
  const toKeep = fields.filter(
    (field) =>
      valueOf(field).trim() !== '' &&
      (changed(field) || (field.outdated && confirmed.has(field.id))),
  );
  const toForget = fields.filter(
    (field) => valueOf(field).trim() === '' && field.kept.trim() !== '',
  );
  const dirty = toKeep.length + toForget.length > 0;

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setProblems([]);
    setSaved(false);
    const found: string[] = [];
    try {
      const resources = [...new Set([...toKeep, ...toForget].map((field) => field.resourceId))];
      for (const resourceId of resources) {
        const keeping = toKeep.filter((field) => field.resourceId === resourceId);
        if (keeping.length > 0) {
          const { translationsRegister } = await register.mutateAsync({
            resourceId,
            translations: keeping.map((field) => ({
              key: field.key,
              locale: 'ur',
              translatableContentDigest: field.digest,
              value: sent(field, valueOf(field)),
            })),
          });
          found.push(...translationsRegister.userErrors.map((each) => problemOf(each, keeping, t)));
        }
        const forgetting = toForget.filter((field) => field.resourceId === resourceId);
        if (forgetting.length > 0) {
          const { translationsRemove } = await remove.mutateAsync({
            resourceId,
            keys: forgetting.map((field) => field.key),
          });
          found.push(...translationsRemove.userErrors.map((each) => problemText(each, t)));
        }
      }
    } catch (failure) {
      found.push(errorText(failure, t));
    }
    // Read again before the fields show what is kept, so they never show it as it was.
    await refetch();
    setBusy(false);
    if (found.length > 0) {
      setProblems(found);
      return;
    }
    setEdits({});
    setConfirmed(new Set());
    setSaved(true);
  };

  if (fields.length === 0) return <EmptyState title={t('urdu.nothing')} />;
  return (
    <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-4">
      {groups
        .filter((group) => group.fields.length > 0)
        .map((group) => (
          <FormSection key={group.title} title={group.title} hint={group.hint}>
            {group.fields.map((field) => (
              <UrduField
                key={field.id}
                field={field}
                value={valueOf(field)}
                onChange={(value) => {
                  setSaved(false);
                  setEdits((now) => ({ ...now, [field.id]: value }));
                }}
                confirmed={confirmed.has(field.id)}
                onConfirm={() => setConfirmed((now) => new Set([...now, field.id]))}
              />
            ))}
          </FormSection>
        ))}
      {problems.length > 0 && (
        <Alert tone="danger">
          <ul className="flex flex-col gap-1">
            {problems.map((problem, index) => (
              <li key={index}>{problem}</li>
            ))}
          </ul>
        </Alert>
      )}
      {saved && !dirty && <Alert tone="success">{t('urdu.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={busy}
        disabled={!dirty}
        icon={<Save aria-hidden className="size-5" />}
      >
        {t('urdu.save')}
      </Button>
    </form>
  );
}

/** The things of `sections`, by ID, as the Urdu page and the cards linking to it ask for them. */
function useInUrdu(sections: readonly UrduSection[]) {
  const ids = sections.flatMap((section) => section.things.map((thing) => thing.id));
  return useAdminQuery<InUrduData>(['inUrdu'], InUrduQuery, { ids });
}

/** The words of `sections` in Urdu, to write and change (OS-06, ADR-327). */
export function UrduWords({ sections }: { sections: readonly UrduSection[] }) {
  const { t } = useLocale();
  const query = useInUrdu(sections);
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  return (
    <UrduForm
      sections={sections}
      nodes={query.data.translatableResourcesByIds.nodes}
      refetch={() => query.refetch()}
    />
  );
}

/**
 * How much of a product's, collection's or page's words are in Urdu, on its own page, and the
 * way to its Urdu: `link`, a link of the caller's to the page of its Urdu.
 */
export function UrduSummary({
  sections,
  link,
}: {
  sections: readonly UrduSection[];
  link: (children: ReactNode) => ReactNode;
}) {
  const { t } = useLocale();
  const id = useId();
  const query = useInUrdu(sections);
  const fields = query.data
    ? sections.flatMap((section) =>
        fieldsOf(section.things, query.data.translatableResourcesByIds.nodes, t),
      )
    : [];
  const count = countOf(fields);
  return (
    <Card className="p-4">
      <section aria-labelledby={id} className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col items-start gap-2">
          <h2 id={id} className="font-semibold">
            {t('urdu.heading')}
          </h2>
          <p className="text-secondary">{t('urdu.cardHint')}</p>
          {query.isError ? (
            <p className="text-danger">{errorText(query.error, t)}</p>
          ) : (
            query.data &&
            count.total > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {urduBadges(count, t).map((badge) => (
                  <Badge key={badge.label} {...badge} />
                ))}
              </div>
            )
          )}
        </div>
        {link(
          <>
            <PenLine aria-hidden className="size-5" />
            {t('urdu.write')}
          </>,
        )}
      </section>
    </Card>
  );
}

/** A link to an Urdu page, styled as the admin's secondary buttons are. */
export const URDU_LINK =
  'inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium text-text hover:bg-canvas md:min-h-10';
