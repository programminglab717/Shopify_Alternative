import { Link, useBlocker, useParams } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  ThemeChoicesQuery,
  ThemeEditorQuery,
  ThemeFilesDeleteMutation,
  ThemeFilesUpsertMutation,
} from '../api/operations';
import type { ThemeChoicesData, ThemeEditorData, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import {
  SETTINGS_FILE,
  addedBlock,
  blockOrderOf,
  blockTypesLeft,
  currentSettings,
  movedBlock,
  movedSection,
  pageFilesOf,
  removedBlock,
  removedSection,
  summaryOf,
  templatesOf,
  toggled,
  toggledBlock,
  withBlockSetting,
  withSetting,
  withThemeSetting,
  type BlockSchema,
  type EditorFile,
  type SectionList,
  type SectionSchema,
  type SettingsData,
  type SettingsGroup,
} from './theme-files';
import { pageSectionId, placeOfSection, samplePathOf, type Samples } from './preview-plan';
import { LivePreview, type FramedPage, type Selection } from './theme-preview';
import { SettingsForm, type Choices } from './theme-settings';
import { EDITS_THEMES } from './themes';

type Theme = NonNullable<ThemeEditorData['theme']>;

/** The core's editor data, its JSON read once. */
interface Prepared {
  groups: SettingsGroup[];
  schemas: Map<string, SectionSchema>;
  names: Map<string, string>;
  files: EditorFile[];
}

function parsed(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function prepare(editor: Theme['editor']): Prepared {
  return {
    groups: ((parsed(editor.settingsSchema) as SettingsGroup[] | null) ?? []).filter((group) =>
      (group.settings ?? []).some((setting) => setting.id !== undefined),
    ),
    schemas: new Map(
      editor.sections.map((each) => [each.type, (parsed(each.schema) ?? {}) as SectionSchema]),
    ),
    names: new Map(editor.sections.map((each) => [each.type, each.name])),
    files: editor.files,
  };
}

/** The element an item of the editor's is, for the preview's choice to bring it into view. */
function itemIdOf(key: string): string {
  return `editor-item-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/** The templates with names in the merchant's words; others go by their own. */
const NAMED = new Set([
  'index',
  'product',
  'collection',
  'page',
  'blog',
  'article',
  'search',
  'cart',
  'password',
  '404',
]);

/** A template's name in the merchant's words: Home page, or Products: unstitched. */
function useTemplateName() {
  const { t } = useLocale();
  return (template: string) => {
    const [base, alternate] = template.split('.');
    const name = NAMED.has(base!) ? t(`editor.page.${base}` as MessageKey) : base!;
    return alternate ? `${name}: ${alternate}` : name;
  };
}

/**
 * A section's or a block's row: its name and first words, opened with a tap, and hidden or shown
 * again beside it, a hidden one saying so. The rest of what may be done with it is inside.
 */
function ItemRow({
  name,
  summary,
  hidden,
  open,
  onOpen,
  onToggle,
  toggleName,
}: {
  name: string;
  summary: string;
  hidden: boolean;
  open: boolean;
  onOpen: () => void;
  /** Absent for what stays shown, such as a page's own section. */
  onToggle?: () => void;
  toggleName: string;
}) {
  const { t } = useLocale();
  return (
    <div className="flex items-start gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={onOpen}
        className="flex min-h-12 min-w-0 flex-1 items-start gap-2 py-2 text-start md:min-h-10"
      >
        <ChevronDown
          aria-hidden
          className={`mt-0.5 size-5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
        <span className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-center gap-x-2 font-medium">
            <span className={hidden ? 'text-secondary line-through' : ''}>{name}</span>
            {hidden && (
              <span className="rounded-full bg-canvas px-2 font-normal text-[length:var(--hatti-type-body-sm-size)]">
                {t('editor.hidden')}
              </span>
            )}
          </span>
          {summary && (
            <span className="line-clamp-2 text-secondary [overflow-wrap:anywhere]" dir="auto">
              {summary}
            </span>
          )}
        </span>
      </button>
      {onToggle && (
        <Button
          variant="tertiary"
          aria-label={t(hidden ? 'editor.show' : 'editor.hide', { name: toggleName })}
          icon={
            hidden ? (
              <EyeOff aria-hidden className="size-5" />
            ) : (
              <Eye aria-hidden className="size-5" />
            )
          }
          onClick={onToggle}
        />
      )}
    </div>
  );
}

/** An open section's or block's tools: moved up or down among its own, and removed. */
function ItemTools({
  title,
  first,
  last,
  onMove,
  onRemove,
}: {
  title: string;
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  /** Absent for what stays, such as a page's own section. */
  onRemove?: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        aria-label={t('editor.moveUp', { name: title })}
        disabled={first}
        icon={<ArrowUp aria-hidden className="size-5" />}
        onClick={() => onMove(-1)}
      >
        {t('editor.up')}
      </Button>
      <Button
        variant="secondary"
        aria-label={t('editor.moveDown', { name: title })}
        disabled={last}
        icon={<ArrowDown aria-hidden className="size-5" />}
        onClick={() => onMove(1)}
      >
        {t('editor.down')}
      </Button>
      {onRemove && (
        <Button
          variant="danger"
          aria-label={t('editor.remove', { name: title })}
          icon={<Trash2 aria-hidden className="size-5" />}
          onClick={onRemove}
        >
          {t('editor.removeShort')}
        </Button>
      )}
    </div>
  );
}

/** One of a section's blocks: its settings, shown or hidden, moved, or removed. */
function BlockItem({
  itemId,
  name,
  schema,
  block,
  first,
  last,
  open,
  onOpen,
  onSetting,
  onToggle,
  onMove,
  onRemove,
  choices,
  storefront,
}: {
  itemId: string;
  name: string;
  schema: BlockSchema | undefined;
  block: { type: string; settings?: Record<string, unknown>; disabled?: boolean };
  first: boolean;
  last: boolean;
  open: boolean;
  onOpen: () => void;
  onSetting: (setting: string, value: unknown) => void;
  onToggle: () => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  choices: Choices;
  storefront: string;
}) {
  const summary = summaryOf(schema?.settings, block.settings);
  const title = summary ? `${name}: ${summary}` : name;
  return (
    <li id={itemId} className="flex flex-col gap-2 rounded-control border border-line px-2">
      <ItemRow
        name={name}
        summary={summary}
        hidden={block.disabled === true}
        open={open}
        onOpen={onOpen}
        onToggle={onToggle}
        toggleName={title}
      />
      {open && (
        <div className="flex flex-col gap-4 pb-3 ps-7">
          <ItemTools title={title} first={first} last={last} onMove={onMove} onRemove={onRemove} />
          <SettingsForm
            settings={schema?.settings}
            values={block.settings}
            onChange={onSetting}
            choices={choices}
            storefront={storefront}
          />
        </div>
      )}
    </li>
  );
}

/**
 * A section of a page: its settings and blocks when open, shown or hidden, moved among the
 * others of its template or group, and, unless it is the page's main section, removed.
 */
function SectionItem({
  itemKey,
  id,
  list,
  data,
  first,
  last,
  open,
  onOpen,
  openBlock,
  onOpenBlock,
  change,
  choices,
  storefront,
}: {
  /** The section's file and key, as the editor keeps which is open. */
  itemKey: string;
  id: string;
  list: SectionList;
  data: Prepared;
  first: boolean;
  last: boolean;
  open: boolean;
  onOpen: () => void;
  openBlock: string | null;
  onOpenBlock: (block: string | null) => void;
  change: (fn: (list: SectionList) => SectionList) => void;
  choices: Choices;
  storefront: string;
}) {
  const { t } = useLocale();
  const placement = list.sections[id]!;
  const schema = data.schemas.get(placement.type);
  const name = data.names.get(placement.type) ?? placement.type;
  const summary = summaryOf(schema?.settings, placement.settings);
  const title = summary ? `${name}: ${summary}` : name;
  // The page's own section, such as the product's, stays: the page would show nothing without it.
  const main = placement.type.startsWith('main-');
  const order = blockOrderOf(placement);
  const left = blockTypesLeft(schema, placement);

  return (
    <li id={itemIdOf(itemKey)} className="flex flex-col gap-3 py-2">
      <ItemRow
        name={name}
        summary={summary}
        hidden={placement.disabled === true}
        open={open}
        onOpen={onOpen}
        onToggle={main ? undefined : () => change((all) => toggled(all, id))}
        toggleName={title}
      />
      {open && (
        <div className="flex flex-col gap-4 pb-3 ps-7">
          <ItemTools
            title={title}
            first={first}
            last={last}
            onMove={(by) => change((all) => movedSection(all, id, by))}
            onRemove={main ? undefined : () => change((all) => removedSection(all, id))}
          />
          {!schema && <p className="text-secondary">{t('editor.unknownSection')}</p>}
          {(schema?.settings?.length ?? 0) > 0 && (
            <SettingsForm
              settings={schema!.settings}
              values={placement.settings}
              onChange={(setting, value) => change((all) => withSetting(all, id, setting, value))}
              choices={choices}
              storefront={storefront}
            />
          )}
          {(schema?.blocks?.length ?? 0) > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="font-semibold">{t('editor.blocks')}</h4>
              {order.length > 0 && (
                <ol className="flex flex-col gap-2">
                  {order.map((blockId, index) => {
                    const block = placement.blocks![blockId]!;
                    const blockSchema = schema!.blocks!.find((each) => each.type === block.type);
                    return (
                      <BlockItem
                        key={blockId}
                        itemId={itemIdOf(`${itemKey}#${blockId}`)}
                        name={blockSchema?.name ?? block.type}
                        schema={blockSchema}
                        block={block}
                        first={index === 0}
                        last={index === order.length - 1}
                        open={openBlock === blockId}
                        onOpen={() => onOpenBlock(openBlock === blockId ? null : blockId)}
                        onSetting={(setting, value) =>
                          change((all) => withBlockSetting(all, id, blockId, setting, value))
                        }
                        onToggle={() => change((all) => toggledBlock(all, id, blockId))}
                        onMove={(by) => change((all) => movedBlock(all, id, blockId, by))}
                        onRemove={() => change((all) => removedBlock(all, id, blockId))}
                        choices={choices}
                        storefront={storefront}
                      />
                    );
                  })}
                </ol>
              )}
              {left.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {left.map((type) => {
                    const blockName = schema!.blocks!.find((each) => each.type === type)?.name;
                    return (
                      <Button
                        key={type}
                        variant="secondary"
                        icon={<Plus aria-hidden className="size-5" />}
                        aria-label={t('editor.addBlockTo', {
                          block: blockName ?? type,
                          name: title,
                        })}
                        onClick={() => change((all) => addedBlock(all, id, type))}
                      >
                        {blockName ?? type}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * One file's part of the page: a section group's or the template's sections. A file that is the
 * shop's own may be started again from the platform theme's; one the storefront leaves out says
 * why.
 */
function FileCard({
  title,
  filename,
  file,
  list,
  data,
  open,
  setOpen,
  openBlock,
  onOpenBlock,
  change,
  onRestore,
  choices,
  storefront,
}: {
  title: string;
  filename: string;
  file: EditorFile | undefined;
  list: SectionList | null;
  data: Prepared;
  open: string | null;
  setOpen: (key: string | null) => void;
  openBlock: string | null;
  onOpenBlock: (block: string | null) => void;
  change: (fn: (list: SectionList) => SectionList) => void;
  onRestore: () => void;
  choices: Choices;
  storefront: string;
}) {
  const { t } = useLocale();
  if (!list) return null;
  const order = list.order.filter((id) => id in list.sections);
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 font-semibold">{title}</h2>
        {file?.own && (
          <Button
            variant="tertiary"
            icon={<RotateCcw aria-hidden className="size-5" />}
            onClick={onRestore}
          >
            {t('editor.restore')}
          </Button>
        )}
      </div>
      {file && file.problems.length > 0 && (
        <Alert tone="warning">
          <p>{t('editor.leftOut')}</p>
          <ul className="mt-1 list-disc ps-5">
            {file.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      )}
      {order.length === 0 ? (
        <p className="text-secondary">{t('editor.noSections')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {order.map((id, index) => {
            const key = `${filename}#${id}`;
            return (
              <SectionItem
                key={key}
                itemKey={key}
                id={id}
                list={list}
                data={data}
                first={index === 0}
                last={index === order.length - 1}
                open={open === key}
                onOpen={() => setOpen(open === key ? null : key)}
                openBlock={open === key ? openBlock : null}
                onOpenBlock={onOpenBlock}
                change={change}
                choices={choices}
                storefront={storefront}
              />
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** The theme's own settings, such as its colours, in the groups the theme gives them. */
function ThemeSettings({
  data,
  settings,
  file,
  change,
  onRestore,
  choices,
  storefront,
}: {
  data: Prepared;
  settings: SettingsData | null;
  file: EditorFile | undefined;
  change: (fn: (data: SettingsData | null) => SettingsData) => void;
  onRestore: () => void;
  choices: Choices;
  storefront: string;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  const values = currentSettings(settings);
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 font-semibold">{t('editor.themeSettings')}</h2>
        {file?.own && (
          <Button
            variant="tertiary"
            icon={<RotateCcw aria-hidden className="size-5" />}
            onClick={onRestore}
          >
            {t('editor.restore')}
          </Button>
        )}
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {data.groups.map((group) => (
          <li key={group.name} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
            <button
              type="button"
              aria-expanded={open === group.name}
              onClick={() => setOpen(open === group.name ? null : group.name)}
              className="flex min-h-12 items-center gap-2 text-start font-medium md:min-h-10"
            >
              <ChevronDown
                aria-hidden
                className={`size-5 transition-transform ${open === group.name ? 'rotate-180' : ''}`}
              />
              {group.name}
            </button>
            {open === group.name && (
              <div className="ps-7">
                <SettingsForm
                  settings={group.settings}
                  values={values}
                  onChange={(setting, value) =>
                    change((old) => withThemeSetting(old, setting, value))
                  }
                  choices={choices}
                  storefront={storefront}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** A page's path without the preview's token, as the editor opens it again. */
function pathOf(path: string): string {
  const url = new URL(path, 'http://storefront');
  url.searchParams.delete('preview');
  return `${url.pathname}${url.search}`;
}

/** The theme's section groups by file, which every page on the theme's layout shows. */
function groupFilesOf(files: readonly EditorFile[]): string[] {
  return files
    .map((file) => file.filename)
    .filter((name) => /^sections\/[a-z0-9_-]+\.json$/.test(name));
}

/**
 * A theme's editor (OS-02, ADR-323): a page of the storefront at a time, its sections from the
 * header to the footer, each one's settings and blocks, shown or hidden and put in order, and the
 * theme's own settings; every change kept here until saved, all at once, as Theme Check passes
 * it. A part the shop changed may be started again from the platform theme's. Beside it, or a
 * tap away on a phone, the page itself shows the changes as they are made (ADR-325).
 */
function Editor({
  theme,
  data,
  choices,
  samples,
}: {
  theme: Theme;
  data: Prepared;
  choices: Choices;
  samples: Samples;
}) {
  const { t } = useLocale();
  const templateName = useTemplateName();
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [template, setTemplate] = useState('index');
  const [open, setOpen] = useState<string | null>(null);
  const [openBlock, setOpenBlock] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  // On a phone, the editor or the preview; side by side on a wide screen.
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  // The page the preview opens, opened again whenever `load` changes.
  const [frame, setFrame] = useState({ path: '/', load: 0 });
  const [framed, setFramed] = useState<FramedPage | null>(null);
  // Where the preview is, or was last sent: another page there is one the merchant went to.
  const framedPath = useRef('/');
  // The preview's link as first given: each time the theme is read again its token is new, and
  // the page in the preview would open again with it.
  const [previewUrl] = useState(theme.previewUrl);
  // An item chosen in the preview, to bring into view once shown.
  const reveal = useRef<string | null>(null);
  const save = useAdminMutation<
    { themeFilesUpsert: { userErrors: UserError[] } },
    { themeId: string; files: { filename: string; body: string }[] }
  >(ThemeFilesUpsertMutation);
  const restore = useAdminMutation<
    { themeFilesDelete: { userErrors: UserError[] } },
    { themeId: string; files: string[] }
  >(ThemeFilesDeleteMutation);
  const changed = Object.keys(drafts).length;

  // Leaving with changes not saved asks first, in the app and when the tab closes.
  useBlocker({
    shouldBlockFn: () => !window.confirm(t('editor.leaveAsk')),
    disabled: changed === 0,
    enableBeforeUnload: () => changed > 0,
  });

  useEffect(() => {
    if (!reveal.current) return;
    document.getElementById(itemIdOf(reveal.current))?.scrollIntoView({ block: 'nearest' });
    reveal.current = null;
  }, [open, openBlock, view]);

  const fileOf = (filename: string) => data.files.find((file) => file.filename === filename);
  const original = (filename: string): unknown => {
    const file = fileOf(filename);
    return file ? parsed(file.body) : null;
  };
  const read = (filename: string): unknown =>
    filename in drafts ? drafts[filename] : original(filename);
  // A change kept until saved; one that brings a file back to as saved is no change.
  const change =
    <T,>(filename: string) =>
    (fn: (json: T) => T) => {
      setSaved(false);
      setDrafts((all) => {
        const next = fn((filename in all ? all[filename] : original(filename)) as T);
        const { [filename]: _before, ...rest } = all;
        return JSON.stringify(next) === JSON.stringify(original(filename))
          ? rest
          : { ...rest, [filename]: next };
      });
    };

  const templates = templatesOf(data.files);
  const storefront = new URL(previewUrl).origin;
  // The page at the preview's link, which shows this theme on any of the storefront's pages.
  const frameSrc = new URL(previewUrl);
  const framePage = new URL(frame.path, storefront);
  frameSrc.pathname = framePage.pathname;
  framePage.searchParams.forEach((value, name) => frameSrc.searchParams.set(name, value));
  // The preview opened again where it is, as saved now.
  const reload = () => setFrame((old) => ({ path: framedPath.current, load: old.load + 1 }));

  const choose = (name: string) => {
    setTemplate(name);
    setOpen(null);
    setOpenBlock(null);
    const path = samplePathOf(name, samples);
    if (path === null) return;
    framedPath.current = path;
    setFrame((old) => ({ path, load: old.load + 1 }));
  };

  // The merchant went to another page in the preview, the editor's own or one it never said it
  // was ready on: the editor shows its template.
  const onPage = (page: FramedPage) => {
    const path = pathOf(page.path);
    const moved = path !== framedPath.current;
    framedPath.current = path;
    setFramed(page);
    const name = /^templates\/(.+)\.json$/.exec(page.template ?? '')?.[1];
    if (moved && name !== undefined && name !== template && templates.includes(name)) {
      setTemplate(name);
      setOpen(null);
      setOpenBlock(null);
    }
  };

  // A section chosen in the preview is opened here, and a block of it.
  const onSelected = ({ section, block }: Selection) => {
    const place = placeOfSection(section, framed?.template ?? null, data.files);
    const list = place ? (read(place.filename) as SectionList | null) : null;
    const placement = place ? list?.sections[place.key] : undefined;
    if (!place || !placement) return;
    const name = /^templates\/(.+)\.json$/.exec(place.filename)?.[1];
    if (name !== undefined && name !== template && templates.includes(name)) setTemplate(name);
    const key = `${place.filename}#${place.key}`;
    const shown = block !== null && placement.blocks?.[block] ? block : null;
    setOpen(key);
    setOpenBlock(shown);
    setView('edit');
    reveal.current = shown === null ? key : `${key}#${shown}`;
  };

  const selection = ((): Selection | null => {
    if (open === null) return null;
    const at = open.indexOf('#');
    const section = pageSectionId(open.slice(0, at), open.slice(at + 1));
    return section === null ? null : { section, block: openBlock };
  })();

  const filesOnPage = (templateFile: string | null) => {
    const name = /^templates\/(.+)\.json$/.exec(templateFile ?? '')?.[1];
    if (name === undefined || !fileOf(templateFile!)) return groupFilesOf(data.files);
    const files = pageFilesOf(name, read, data.files);
    return [...files.above, files.template, ...files.below];
  };

  const onSave = async () => {
    setProblems([]);
    setSaved(false);
    try {
      const files = Object.entries(drafts).map(([filename, json]) => ({
        filename,
        body: `${JSON.stringify(json, null, 2)}\n`,
      }));
      const errors = (await save.mutateAsync({ themeId: theme.id, files })).themeFilesUpsert
        .userErrors;
      if (errors.length > 0) {
        setProblems(errors.map((error) => error.message));
        return;
      }
      setDrafts({});
      setSaved(true);
      // The theme's settings show in the preview only on a page loaded with them.
      if (SETTINGS_FILE in drafts) reload();
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  const onRestore = async (filename: string) => {
    setProblems([]);
    try {
      const errors = (await restore.mutateAsync({ themeId: theme.id, files: [filename] }))
        .themeFilesDelete.userErrors;
      if (errors.length > 0) {
        setProblems(errors.map((error) => error.message));
        return;
      }
      setRestoring(null);
      setDrafts(({ [filename]: _dropped, ...rest }) => rest);
      if (filename === SETTINGS_FILE) reload();
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  const page = pageFilesOf(template, read, data.files);
  const groupTitle = (filename: string) => {
    const group = read(filename) as SectionList | null;
    if (group?.type === 'header') return t('editor.group.header');
    if (group?.type === 'footer') return t('editor.group.footer');
    return group?.name ?? filename;
  };
  const card = (filename: string, title: string) => (
    <FileCard
      key={filename}
      title={title}
      filename={filename}
      file={fileOf(filename)}
      list={read(filename) as SectionList | null}
      data={data}
      open={open}
      setOpen={(key) => {
        setOpen(key);
        setOpenBlock(null);
      }}
      openBlock={openBlock}
      onOpenBlock={setOpenBlock}
      change={change<SectionList>(filename)}
      onRestore={() => setRestoring(filename)}
      choices={choices}
      storefront={storefront}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-md">
        <SelectField
          label={t('editor.pageLabel')}
          value={template}
          options={templates.map((name) => ({ value: name, label: templateName(name) }))}
          onChange={choose}
        />
      </div>
      <div
        role="tablist"
        aria-label={t('editor.views')}
        className="grid grid-cols-2 gap-1 rounded-control border border-line p-1 lg:hidden"
      >
        {(['edit', 'preview'] as const).map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={view === each}
            onClick={() => setView(each)}
            className={`min-h-12 rounded-control md:min-h-10 ${
              view === each ? 'bg-primary text-on-primary' : 'text-secondary'
            }`}
          >
            {t(each === 'edit' ? 'editor.view.edit' : 'editor.view.preview')}
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(22rem,28rem)_minmax(0,1fr)] lg:items-start">
        <div className={`flex-col gap-4 ${view === 'edit' ? 'flex' : 'hidden lg:flex'}`}>
          {restoring && (
            <Alert tone="warning">
              <p>
                {t('editor.restoreAsk', {
                  part:
                    restoring === SETTINGS_FILE
                      ? t('editor.themeSettings')
                      : restoring.startsWith('templates/')
                        ? templateName(template)
                        : groupTitle(restoring),
                })}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="destructive"
                  busy={restore.isPending}
                  onClick={() => void onRestore(restoring)}
                >
                  {t('editor.restoreSure')}
                </Button>
                <Button variant="secondary" onClick={() => setRestoring(null)}>
                  {t('action.back')}
                </Button>
              </div>
            </Alert>
          )}
          {page.above.map((filename) => card(filename, groupTitle(filename)))}
          {card(page.template, templateName(template))}
          {page.below.map((filename) => card(filename, groupTitle(filename)))}
          <ThemeSettings
            data={data}
            settings={read(SETTINGS_FILE) as SettingsData | null}
            file={fileOf(SETTINGS_FILE)}
            change={change<SettingsData | null>(SETTINGS_FILE)}
            onRestore={() => setRestoring(SETTINGS_FILE)}
            choices={choices}
            storefront={storefront}
          />
          {problems.length > 0 && (
            <Alert tone="danger">
              <p>{t('editor.refused')}</p>
              <ul className="mt-1 list-disc ps-5">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Alert>
          )}
          {saved && (
            <Alert tone="success">
              {theme.role === 'MAIN' ? t('editor.savedLive') : t('editor.saved')}
            </Alert>
          )}
        </div>
        <div
          className={`h-[75dvh] min-h-96 flex-col lg:sticky lg:top-20 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:h-[calc(100dvh-6.5rem)] ${
            view === 'preview' ? 'flex' : 'hidden lg:flex'
          }`}
        >
          <LivePreview
            src={frameSrc.toString()}
            load={frame.load}
            storefront={storefront}
            title={t('editor.preview.title', { name: theme.name })}
            changes={drafts}
            filesOnPage={filesOnPage}
            nowOf={(filename) => JSON.stringify(read(filename))}
            savedOf={(filename) => JSON.stringify(original(filename))}
            selection={selection}
            onPage={onPage}
            onSelected={onSelected}
            onReload={reload}
            settingsUnsaved={SETTINGS_FILE in drafts}
            missing={
              framed !== null &&
              framed.template !== page.template &&
              samplePathOf(template, samples) === null
            }
          />
        </div>
        {changed > 0 && (
          <div className="sticky bottom-20 z-10 flex flex-wrap items-center gap-2 rounded-control border border-line bg-surface p-3 shadow-lg md:bottom-4 lg:col-start-1">
            <span className="flex-1 font-medium">{t('editor.unsaved')}</span>
            <Button variant="secondary" onClick={() => setDrafts({})}>
              {t('editor.discard')}
            </Button>
            <Button
              busy={save.isPending}
              icon={<Save aria-hidden className="size-5" />}
              onClick={() => void onSave()}
            >
              {t('editor.save')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The theme editor's page: the theme, and what its settings may point at in the shop. */
export function ThemeEditorPage() {
  const { t, locale } = useLocale();
  const { id: shopId, role } = useShop();
  const { themeId } = useParams({ from: '/$shopId/online-store/themes/$themeId' });
  const edits = EDITS_THEMES.includes(role);
  const query = useAdminQuery<ThemeEditorData>(
    ['theme-editor', themeId, locale],
    ThemeEditorQuery,
    { id: themeId, locale },
    { enabled: edits },
  );
  const picks = useAdminQuery<ThemeChoicesData>(
    ['theme-choices'],
    ThemeChoicesQuery,
    {},
    {
      enabled: edits,
    },
  );
  const back = (
    <Link
      to="/$shopId/online-store"
      params={{ shopId }}
      search={{ tab: 'themes' }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('editor.back')}
    </Link>
  );

  if (!edits) return <EmptyState title={t('editor.cannot')} />;
  if (query.isError || picks.isError) {
    const failed = query.isError ? query : picks;
    return (
      <ErrorState
        message={errorText(failed.error, t)}
        action={<Button onClick={() => void failed.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  if (query.isPending || picks.isPending) return <Loading label={t('state.loading')} />;
  const theme = query.data.theme;
  const choices: Choices = {
    menus: picks.data.menus.nodes.map((menu) => ({ value: menu.handle, label: menu.title })),
    collections: picks.data.collections.nodes.map((each) => ({
      value: each.handle,
      label: each.title,
    })),
  };
  // The pages the storefront shows now, for the preview to open a template on.
  const now = Date.now();
  const shown = (each: { isPublished: boolean; publishedAt: string | null }) =>
    each.isPublished && (each.publishedAt === null || Date.parse(each.publishedAt) <= now);
  const samples: Samples = {
    product: picks.data.products.nodes[0]?.handle ?? null,
    pages: picks.data.pages.nodes.filter(shown),
    blogs: picks.data.blogs.nodes,
    articles: picks.data.articles.nodes.filter(shown).map((each) => ({
      handle: each.handle,
      templateSuffix: each.templateSuffix,
      blog: each.blog.handle,
    })),
  };

  return (
    <div className="mx-auto flex w-full max-w-[120rem] flex-col gap-4 pb-8">
      {back}
      {!theme ? (
        <EmptyState title={t('editor.notFound')} />
      ) : (
        <>
          <h1 className="flex flex-wrap items-center gap-3 text-[length:var(--hatti-type-display-size)] font-semibold">
            <span dir="auto">{t('editor.title', { name: theme.name })}</span>
            {theme.role === 'MAIN' && (
              <span className="rounded-full bg-primary px-2 text-on-primary text-[length:var(--hatti-type-body-sm-size)] font-medium">
                {t('themes.live')}
              </span>
            )}
          </h1>
          <Editor theme={theme} data={prepare(theme.editor)} choices={choices} samples={samples} />
        </>
      )}
    </div>
  );
}
