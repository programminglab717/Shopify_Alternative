import { ExternalLink, Monitor, RefreshCw, Smartphone } from 'lucide-react';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/locale';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { previewRender, renderGroups } from './preview-plan';

/** A section of the page in the preview, as the storefront's script there tells it. */
export interface FramedSection {
  id: string;
  file: string;
  key: string;
}

/** The page in the preview, as the storefront's script there tells it. */
export interface FramedPage {
  /** Its path, with its query. */
  path: string;
  /** Its template's file, such as templates/product.json; null for a page without one. */
  template: string | null;
  sections: FramedSection[];
}

/** A section of the page chosen, and a block of it. */
export interface Selection {
  section: string;
  block: string | null;
}

/** How long a page in the frame has to say it is ready before the preview says it shows no changes. */
const SILENT_MS = 8_000;
/** How long after a change the preview waits for the next before rendering. */
const QUIET_MS = 250;

/**
 * The theme editor's preview (ADR-325): a page of the storefront in a frame, in design mode, its
 * sections rendered again with the editor's changes as the merchant makes them, and the section
 * chosen in either chosen in both. What it shows only once saved, it says.
 */
export function LivePreview({
  src,
  load,
  storefront,
  title,
  changes,
  filesOnPage,
  nowOf,
  savedOf,
  selection,
  onPage,
  onSelected,
  onReload,
  settingsUnsaved,
  missing,
}: {
  /** The page to open, with the preview's token. */
  src: string;
  /** Changed to open the page again. */
  load: number;
  /** The storefront's origin, which alone may answer. */
  storefront: string;
  title: string;
  /** A new value each time the editor's files change. */
  changes: unknown;
  /** The theme's files a page with the template shows. */
  filesOnPage: (template: string | null) => string[];
  /** A file as the editor has it now, and as saved, each as JSON. */
  nowOf: (filename: string) => string;
  savedOf: (filename: string) => string;
  selection: Selection | null;
  onPage: (page: FramedPage) => void;
  onSelected: (selection: Selection) => void;
  onReload: () => void;
  /** Whether the theme's settings have changes, which the preview shows once saved. */
  settingsUnsaved: boolean;
  /** Whether no page of the shop's shows the editor's template, so the preview shows another. */
  missing: boolean;
}) {
  const { t } = useLocale();
  const frame = useRef<HTMLIFrameElement>(null);
  // What the frame shows: its page, and each of the page's files as JSON.
  const page = useRef<FramedPage | null>(null);
  const shown = useRef<Record<string, string>>({});
  // Renders asked for and not answered yet, and whether changes came meanwhile.
  const pending = useRef(new Set<number>());
  const asked = useRef(0);
  const again = useRef(false);
  const heard = useRef<string[]>([]);
  // The section the merchant chose in the page, not to be sent back to it.
  const chosenThere = useRef<string | null>(null);
  const [loads, setLoads] = useState(0);
  const [phase, setPhase] = useState<'loading' | 'live' | 'silent'>('loading');
  const [updating, setUpdating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [device, setDevice] = useState<'full' | 'phone'>('full');

  const post = (message: Record<string, unknown>) =>
    frame.current?.contentWindow?.postMessage(message, storefront);

  // The page's files as the editor has them, sent for the sections they change to be rendered.
  const sync = useEffectEvent(() => {
    const here = page.current;
    if (!here) return;
    if (pending.current.size > 0) {
      again.current = true;
      return;
    }
    const plan = previewRender(
      filesOnPage(here.template),
      (filename) => shown.current[filename] ?? savedOf(filename),
      nowOf,
      savedOf,
    );
    if (plan.changed.length === 0) return;
    heard.current = [];
    setFailure(null);
    for (const sections of renderGroups(plan.sections)) {
      asked.current += 1;
      pending.current.add(asked.current);
      post({ type: 'hatti:render', id: asked.current, sections, files: plan.files });
    }
    for (const filename of plan.changed) shown.current[filename] = nowOf(filename);
    setUpdating(true);
  });

  // The section open in the editor chosen in the page; on a page just loaded, nothing is chosen.
  const select = useEffectEvent((loaded: boolean) => {
    if (!page.current || (loaded && !selection)) return;
    const chosen = selection ? JSON.stringify(selection) : null;
    if (chosen !== null && chosen === chosenThere.current) return;
    chosenThere.current = null;
    post(
      selection
        ? { type: 'hatti:select', section: selection.section, block: selection.block }
        : { type: 'hatti:deselect' },
    );
  });

  const hear = useEffectEvent((event: MessageEvent) => {
    if (event.origin !== storefront || event.source !== frame.current?.contentWindow) return;
    const message = (
      typeof event.data === 'object' && event.data !== null ? event.data : {}
    ) as Record<string, unknown>;
    if (message.type === 'hatti:ready') {
      const told = (message.page ?? {}) as { path?: unknown; template?: unknown };
      const here: FramedPage = {
        path: typeof told.path === 'string' ? told.path : '/',
        template: typeof told.template === 'string' ? told.template : null,
        sections: Array.isArray(message.sections) ? (message.sections as FramedSection[]) : [],
      };
      // A page loaded afresh shows the theme as saved.
      page.current = here;
      shown.current = Object.fromEntries(
        filesOnPage(here.template).map((filename) => [filename, savedOf(filename)]),
      );
      pending.current.clear();
      again.current = false;
      chosenThere.current = null;
      setPhase('live');
      setUpdating(false);
      setFailure(null);
      setProblems([]);
      onPage(here);
      sync();
      select(true);
    } else if (message.type === 'hatti:selected' && typeof message.section === 'string') {
      const chosen = {
        section: message.section,
        block: typeof message.block === 'string' ? message.block : null,
      };
      chosenThere.current = JSON.stringify(chosen);
      onSelected(chosen);
    } else if (message.type === 'hatti:rendered' || message.type === 'hatti:failed') {
      // A render's answer; a failure without an id is a selection the page could not make.
      if (typeof message.id !== 'number' || !pending.current.delete(message.id)) return;
      if (message.type === 'hatti:failed') {
        setFailure(typeof message.message === 'string' ? message.message : '');
      } else if (Array.isArray(message.problems)) {
        heard.current.push(
          ...message.problems.filter((each): each is string => typeof each === 'string'),
        );
      }
      if (pending.current.size > 0) return;
      setProblems([...new Set(heard.current)]);
      setUpdating(false);
      if (again.current) {
        again.current = false;
        sync();
      }
    }
  });

  useEffect(() => {
    const listener = (event: MessageEvent) => hear(event);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  // Changes render once the merchant pauses.
  useEffect(() => {
    const timer = setTimeout(() => sync(), QUIET_MS);
    return () => clearTimeout(timer);
  }, [changes]);

  useEffect(() => {
    select(false);
  }, [selection?.section, selection?.block]);

  // A page opened again is not ready until it says so, and renders asked of the last go unheard;
  // forgotten before the new page can say anything.
  useLayoutEffect(() => {
    page.current = null;
    pending.current.clear();
    again.current = false;
    setUpdating(false);
    setPhase('loading');
  }, [load]);

  // A page that never says it is ready is not in design mode, or not the storefront's.
  useEffect(() => {
    if (loads === 0) return;
    const timer = setTimeout(() => {
      if (!page.current) setPhase('silent');
    }, SILENT_MS);
    return () => clearTimeout(timer);
  }, [loads]);

  const onLoad = () => {
    page.current = null;
    setPhase('loading');
    setLoads((count) => count + 1);
    post({ type: 'hatti:hello' });
  };

  return (
    <section
      aria-label={t('editor.preview.heading')}
      className="flex min-h-0 flex-1 flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-1">
        <h2 className="font-semibold">{t('editor.preview.heading')}</h2>
        <span
          role="status"
          className="flex-1 px-2 text-secondary text-[length:var(--hatti-type-body-sm-size)]"
        >
          {phase === 'loading'
            ? t('editor.preview.loading')
            : updating
              ? t('editor.preview.updating')
              : ''}
        </span>
        <div className="hidden gap-1 lg:flex">
          <Button
            variant="tertiary"
            aria-pressed={device === 'full'}
            aria-label={t('editor.preview.full')}
            icon={<Monitor aria-hidden className="size-5" />}
            className={device === 'full' ? 'bg-canvas' : ''}
            onClick={() => setDevice('full')}
          />
          <Button
            variant="tertiary"
            aria-pressed={device === 'phone'}
            aria-label={t('editor.preview.phone')}
            icon={<Smartphone aria-hidden className="size-5" />}
            className={device === 'phone' ? 'bg-canvas' : ''}
            onClick={() => setDevice('phone')}
          />
        </div>
        <Button
          variant="tertiary"
          aria-label={t('editor.preview.reload')}
          icon={<RefreshCw aria-hidden className="size-5" />}
          onClick={onReload}
        />
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          aria-label={t('editor.preview.open')}
          className="inline-flex min-h-12 items-center rounded-control px-4 text-primary hover:bg-canvas md:min-h-10"
        >
          <ExternalLink aria-hidden className="size-5" />
        </a>
      </div>
      {missing && <Alert tone="info">{t('editor.preview.otherPage')}</Alert>}
      {settingsUnsaved && <Alert tone="info">{t('editor.preview.settingsLater')}</Alert>}
      {phase === 'silent' && <Alert tone="warning">{t('editor.preview.silent')}</Alert>}
      {failure !== null && (
        <Alert tone="danger">
          {failure
            ? t('editor.preview.failedWhy', { message: failure })
            : t('editor.preview.failed')}
        </Alert>
      )}
      {problems.length > 0 && (
        <Alert tone="warning">
          <p>{t('editor.preview.leftOut')}</p>
          <ul className="mt-1 list-disc ps-5">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      )}
      <div className="flex min-h-0 flex-1 justify-center overflow-hidden rounded-control border border-line bg-canvas">
        <iframe
          key={load}
          ref={frame}
          src={src}
          title={title}
          // The storefront's own scripts run and its forms post, but it cannot take the admin's
          // place in the tab.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          onLoad={onLoad}
          className={`h-full border-0 bg-white ${device === 'phone' ? 'w-[390px] max-w-full border-x border-line' : 'w-full'}`}
        />
      </div>
    </section>
  );
}
