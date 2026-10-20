/** What of the shop's is in Urdu and what is left to write, kind by kind (OS-06). */
import { Link } from '@tanstack/react-router';
import { ChevronRight, CircleCheck } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  TranslationsRegisterMutation,
  TranslationsRemoveMutation,
  UrduOverviewQuery,
} from '../api/operations';
import type { UrduKind, UrduOverviewData, UrduResource, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { CheckField, SelectField } from '../settings/settings-form';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { LABELS, urduBadges } from './in-urdu';
import type { UrduCount } from './in-urdu';

export const URDU_KINDS: readonly UrduKind[] = [
  'PRODUCT',
  'COLLECTION',
  'ONLINE_STORE_PAGE',
  'ONLINE_STORE_BLOG',
  'ONLINE_STORE_ARTICLE',
  'MENU',
  'SHOP',
];

/** How many are listed at first, and the most the core lists at once. */
const FIRST = 100;
const MOST = 250;

/** How much of a thing's own words are in Urdu: its fields with words, those written, and those out of date. */
export function urduCount(resource: UrduResource): UrduCount {
  const keys = new Set(
    resource.translatableContent
      .filter((content) => content.digest && content.value)
      .map((content) => content.key),
  );
  const written = resource.translations.filter(
    (translation) => keys.has(translation.key) && (translation.value ?? '').trim() !== '',
  );
  return {
    total: keys.size,
    written: written.length,
    outdated: written.filter((translation) => translation.outdated).length,
  };
}

/** Whether something has words still to write in Urdu, or Urdu to check. */
const left = (count: UrduCount) => count.written < count.total || count.outdated > 0;

function nameOf(kind: UrduKind, resource: UrduResource, t: Translate): string {
  if (kind === 'SHOP') return t('urdu.homePageName');
  const title = resource.translatableContent.find((content) => content.key === 'title')?.value;
  return title?.trim() || t('urduAll.untitled');
}

const ROW = 'flex flex-wrap items-center gap-2 px-4 py-3 hover:bg-canvas';

/** A link to where the Urdu of a thing of `kind` is written. */
function UrduLink({ kind, id, children }: { kind: UrduKind; id: string; children: ReactNode }) {
  const shopId = useShop().id;
  switch (kind) {
    case 'PRODUCT':
      return (
        <Link
          to="/$shopId/products/$productId/urdu"
          params={{ shopId, productId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'COLLECTION':
      return (
        <Link
          to="/$shopId/collections/$collectionId/urdu"
          params={{ shopId, collectionId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'ONLINE_STORE_PAGE':
      return (
        <Link
          to="/$shopId/online-store/pages/$pageId/urdu"
          params={{ shopId, pageId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'ONLINE_STORE_BLOG':
      return (
        <Link
          to="/$shopId/online-store/blogs/$blogId/urdu"
          params={{ shopId, blogId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'ONLINE_STORE_ARTICLE':
      return (
        <Link
          to="/$shopId/online-store/articles/$articleId/urdu"
          params={{ shopId, articleId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'MENU':
      return (
        <Link
          to="/$shopId/online-store/menus/$menuId/urdu"
          params={{ shopId, menuId: id }}
          className={ROW}
        >
          {children}
        </Link>
      );
    case 'SHOP':
      return (
        <Link to="/$shopId/online-store/home-page/urdu" params={{ shopId }} className={ROW}>
          {children}
        </Link>
      );
  }
}

/** The fields of a line or two that are put in Urdu across many things at once (ADR-650). */
const SHEET_KEYS = ['title', 'product_type', 'meta_title', 'meta_description'] as const;

/** A thing's own words for `key`, with their digest, if it has any. */
function wordsOf(resource: UrduResource, key: string) {
  const content = resource.translatableContent.find((each) => each.key === key);
  return content?.value?.trim() && content.digest
    ? { value: content.value, digest: content.digest }
    : null;
}

/**
 * One field of many things in Urdu at once (ADR-650): each thing's own words above its Urdu, those
 * changed kept together through `translationsRegister`, and those emptied forgotten.
 */
function FieldSheet({
  kind,
  field,
  things,
  leftOnly,
}: {
  kind: UrduKind;
  field: string;
  things: UrduResource[];
  leftOnly: boolean;
}) {
  const { t } = useLocale();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(0);
  const register = useAdminMutation<
    { translationsRegister: { userErrors: UserError[] } },
    { resourceId: string; translations: Record<string, string>[] }
  >(TranslationsRegisterMutation);
  const remove = useAdminMutation<
    { translationsRemove: { userErrors: UserError[] } },
    { resourceId: string; keys: string[] }
  >(TranslationsRemoveMutation);

  const rows = things.flatMap((node) => {
    const words = wordsOf(node, field);
    if (!words) return [];
    const urdu = node.translations.find((each) => each.key === field);
    const kept = urdu?.value ?? '';
    const outdated = Boolean(urdu?.outdated && kept.trim());
    // Those still to write stay while they are being written.
    const isLeft = !kept.trim() || outdated || edits[node.resourceId] !== undefined;
    return leftOnly && !isLeft
      ? []
      : [{ node, words, kept, outdated, name: nameOf(kind, node, t) }];
  });
  const valueOf = (row: (typeof rows)[number]) => edits[row.node.resourceId] ?? row.kept;
  const changed = rows.filter((row) => valueOf(row).trim() !== row.kept.trim());

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    if (changed.length === 0 || busy) return;
    setBusy(true);
    setProblems([]);
    setSaved(0);
    const found: string[] = [];
    let kept = 0;
    for (const row of changed) {
      const value = valueOf(row).trim();
      try {
        const errors = value
          ? (
              await register.mutateAsync({
                resourceId: row.node.resourceId,
                translations: [
                  {
                    key: field,
                    locale: 'ur',
                    translatableContentDigest: row.words.digest,
                    value,
                  },
                ],
              })
            ).translationsRegister.userErrors
          : (await remove.mutateAsync({ resourceId: row.node.resourceId, keys: [field] }))
              .translationsRemove.userErrors;
        if (errors.length > 0) {
          found.push(`${row.name}: ${problemText(errors[0]!, t)}`);
        } else {
          kept += 1;
          setEdits((now) => {
            const { [row.node.resourceId]: _done, ...rest } = now;
            return rest;
          });
        }
      } catch (failure) {
        found.push(`${row.name}: ${errorText(failure, t)}`);
      }
    }
    setBusy(false);
    setProblems(found);
    setSaved(kept);
  };

  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<CircleCheck aria-hidden className="size-8 text-success" />}
          title={t('urduAll.allDone')}
        />
      </Card>
    );
  }
  return (
    <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
      <Card>
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.node.resourceId} className="flex flex-col gap-1 px-4 py-3">
              <span className="text-secondary" dir="auto">
                {row.words.value}
              </span>
              <TextField
                label={t('urduAll.inUrdu', { words: row.words.value })}
                hint={row.outdated ? t('urduAll.fieldOutdated') : undefined}
                lang="ur"
                dir="rtl"
                value={valueOf(row)}
                onChange={(event) =>
                  setEdits((now) => ({ ...now, [row.node.resourceId]: event.target.value }))
                }
              />
            </li>
          ))}
        </ul>
      </Card>
      {problems.map((problem) => (
        <Alert key={problem} tone="danger">
          {problem}
        </Alert>
      ))}
      {saved > 0 && changed.length === 0 && (
        <Alert tone="success">{t('urduAll.fieldSaved', { count: saved })}</Alert>
      )}
      <Button type="submit" className="self-start" busy={busy} disabled={changed.length === 0}>
        {t('urduAll.fieldSave', { count: changed.length })}
      </Button>
    </form>
  );
}

/** The things of one kind, the newest first, each with how much of it is in Urdu. */
function KindList({ kind, leftOnly }: { kind: UrduKind; leftOnly: boolean }) {
  const { t } = useLocale();
  const [first, setFirst] = useState(FIRST);
  // A field written across them all, or each opened on its own page.
  const [field, setField] = useState('');
  const query = useAdminQuery<UrduOverviewData>(
    ['urduOverview', kind],
    UrduOverviewQuery,
    { type: kind, first },
    { keepPrevious: true },
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
  const { nodes, pageInfo } = query.data.translatableResources;
  // Those without words of their own have nothing to put in Urdu.
  const things = nodes
    .map((node) => ({ node, count: urduCount(node) }))
    .filter(({ count }) => count.total > 0);
  const done = things.filter(({ count }) => !left(count)).length;
  const shown = leftOnly ? things.filter(({ count }) => left(count)) : things;
  const keys = SHEET_KEYS.filter((key) => things.some(({ node }) => wordsOf(node, key)));

  return (
    <div className="flex flex-col gap-3">
      {things.length > 0 && (
        <p className="text-secondary">
          {t(pageInfo.hasNextPage ? 'urduAll.summaryNewest' : 'urduAll.summary', {
            done: String(done),
            count: String(things.length),
          })}
        </p>
      )}
      {keys.length > 0 && (
        <SelectField
          label={t('urduAll.write')}
          value={field}
          options={[
            { value: '', label: t('urduAll.eachOnItsPage') },
            ...keys.map((key) => ({
              value: key,
              label: t('urduAll.oneField', { field: t(LABELS[key]!) }),
            })),
          ]}
          onChange={setField}
        />
      )}
      {field ? (
        <FieldSheet
          key={field}
          kind={kind}
          field={field}
          things={things.map(({ node }) => node)}
          leftOnly={leftOnly}
        />
      ) : things.length === 0 ? (
        <Card>
          <EmptyState title={t('urduAll.none')} />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CircleCheck aria-hidden className="size-8 text-success" />}
            title={t('urduAll.allDone')}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {shown.map(({ node, count }) => (
              <li key={node.resourceId}>
                <UrduLink kind={kind} id={node.resourceId}>
                  <span className="min-w-0 flex-1 font-medium" dir="auto">
                    {nameOf(kind, node, t)}
                  </span>
                  {urduBadges(count, t).map((badge) => (
                    <Badge key={badge.label} {...badge} />
                  ))}
                  <ChevronRight aria-hidden className="size-5 text-secondary rtl:rotate-180" />
                </UrduLink>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {pageInfo.hasNextPage &&
        (first < MOST ? (
          <Button
            variant="tertiary"
            className="self-start"
            busy={query.isFetching}
            onClick={() => setFirst(MOST)}
          >
            {t('orders.more')}
          </Button>
        ) : (
          <p className="text-secondary">{t('urduAll.newest', { count: String(MOST) })}</p>
        ))}
    </div>
  );
}

/**
 * The online store's Urdu (OS-06, ADR-238): the shop's products, collections, pages, blogs,
 * articles and menus, and its home page, kind by kind, the newest first, each with how much of its
 * own words its Urdu pages show in Urdu and how much was written for words since changed; at first
 * only those with something left to write or check, each opening where its Urdu is written, or a
 * field of theirs written across them all at once (ADR-650).
 */
export function UrduOverview() {
  const { t } = useLocale();
  const [kind, setKind] = useState<UrduKind>('PRODUCT');
  const [leftOnly, setLeftOnly] = useState(true);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-secondary">{t('urduAll.hint')}</p>
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <SelectField<UrduKind>
          label={t('urduAll.show')}
          value={kind}
          options={URDU_KINDS.map((each) => ({
            value: each,
            label: t(`urduAll.kind.${each}` as MessageKey),
          }))}
          onChange={setKind}
        />
        <CheckField label={t('urduAll.leftOnly')} checked={leftOnly} onChange={setLeftOnly} />
      </div>
      <KindList key={kind} kind={kind} leftOnly={leftOnly} />
    </div>
  );
}
