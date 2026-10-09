import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { editorAttribute, editorListMark, editorScript } from './editor.js';

const EDITOR = 'https://admin.hatti.pk';
const HOME = 'templates/index.json';
const FOOTER = 'sections/footer-group.json';

/** A section as the storefront renders it in the editor's frame. */
function section(id: string, file: string, key: string, words = id): string {
  const place = editorAttribute('data-hatti-editor-section', {
    id,
    type: 'rich-text',
    file,
    key,
  });
  return `<div id="hatti-section-${id}" class="hatti-section" ${place}><p>${words}</p></div>`;
}

/** A template or a section group as the editor sends it, its sections all rich text. */
function list(order: string[], disabled: string[] = []): string {
  return JSON.stringify({
    sections: Object.fromEntries(
      order.map((key) => [
        key,
        disabled.includes(key) ? { type: 'rich-text', disabled: true } : { type: 'rich-text' },
      ]),
    ),
    order,
  });
}

/** What a message comes from, as happy-dom's events take it. */
type Source = NonNullable<ConstructorParameters<Window['MessageEvent']>[1]>['source'];

let opened: Window | null = null;

afterEach(async () => {
  await opened?.happyDOM.close();
  opened = null;
});

/**
 * A page in the editor's frame with its script running: what the script tells the editor, the
 * renders it asks the storefront for, answered with `rendered`, and the theme editor events the
 * page's sections hear.
 */
function framed(body: string, rendered: Record<string, string | null> = {}) {
  const window = new Window({
    url: 'https://zari.hatti.pk/',
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  opened = window;
  const { document } = window;
  const told: Record<string, unknown>[] = [];
  const asked: { sections: string[]; files: Record<string, string> }[] = [];
  const heard: string[] = [];
  // Framed, the editor is the page's parent; on its own, the page is its own.
  window.postMessage = ((message: Record<string, unknown>) => {
    told.push(message);
  }) as typeof window.postMessage;
  window.fetch = (async (_url: string, init: { body: string }) => {
    asked.push(JSON.parse(init.body) as (typeof asked)[number]);
    return { ok: true, json: async () => ({ sections: rendered, problems: [] }) };
  }) as unknown as typeof window.fetch;
  document.body.innerHTML = body;
  for (const name of ['load', 'unload', 'reorder']) {
    document.addEventListener(`shopify:section:${name}`, (event) => {
      const { detail } = event as unknown as { detail: { sectionId: string } };
      heard.push(`${name} ${detail.sectionId}`);
    });
  }
  // The page's window as its scripts see it, which messages from the editor's frame come from.
  const prelude = document.createElement('script');
  prelude.textContent = 'window.hattiItself = window;';
  document.head.append(prelude);
  const itself = (window as unknown as { hattiItself: Source }).hattiItself;
  // The script as the page's head has it, run.
  const template = document.createElement('template');
  template.innerHTML = editorScript({ origins: [EDITOR], template: HOME });
  const inert = template.content.querySelector('script')!;
  const script = document.createElement('script');
  script.setAttribute('data-hatti-editor', inert.getAttribute('data-hatti-editor')!);
  script.textContent = inert.textContent;
  document.head.append(script);

  const tell = (data: Record<string, unknown>) =>
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data,
        origin: EDITOR,
        source: itself,
      }),
    );
  const ids = () =>
    [...document.querySelectorAll('[data-hatti-editor-section]')].map((element) =>
      element.id.replace('hatti-section-', ''),
    );
  tell({ type: 'hatti:hello' });
  return { document, told, asked, heard, tell, ids };
}

const PAGE =
  editorListMark('sections/header-group.json') +
  section('header-group__header', 'sections/header-group.json', 'header') +
  `<main>${editorListMark(HOME)}${section('a', HOME, 'a')}${section('b', HOME, 'b')}` +
  `${section('c', HOME, 'c')}</main>` +
  `<footer>${editorListMark(FOOTER)}${section('footer-group__links', FOOTER, 'links')}</footer>`;

describe("The theme editor's script in the preview", () => {
  it('tells the editor the page and its sections, each with where its settings are kept', () => {
    const page = framed(PAGE);
    expect(page.told).toEqual([
      {
        type: 'hatti:ready',
        page: { path: '/', locale: '', template: HOME },
        sections: [
          expect.objectContaining({ id: 'header-group__header', key: 'header', blocks: [] }),
          expect.objectContaining({ id: 'a', file: HOME, key: 'a' }),
          expect.objectContaining({ id: 'b' }),
          expect.objectContaining({ id: 'c' }),
          expect.objectContaining({ id: 'footer-group__links', file: FOOTER }),
        ],
      },
    ]);
  });

  it("puts a template's sections in its order, without asking for any to be rendered", async () => {
    const page = framed(PAGE);
    page.tell({ type: 'hatti:render', sections: [], files: { [HOME]: list(['c', 'a', 'b']) } });
    await expect.poll(() => page.told.at(-1)?.type).toBe('hatti:rendered');
    expect(page.ids()).toEqual(['header-group__header', 'c', 'a', 'b', 'footer-group__links']);
    expect(page.asked).toEqual([]);
    // Each that moved among the others hears it; one that stayed in its place does not.
    expect(page.heard).toEqual(['reorder c', 'reorder a', 'reorder b']);
    expect(page.told.at(-1)).toEqual({ type: 'hatti:rendered', sections: [], problems: [] });
  });

  it('takes away the sections a file hides or no longer has', async () => {
    const page = framed(PAGE);
    page.tell({ type: 'hatti:render', sections: [], files: { [HOME]: list(['a', 'b'], ['b']) } });
    await expect.poll(() => page.told.at(-1)?.type).toBe('hatti:rendered');
    expect(page.ids()).toEqual(['header-group__header', 'a', 'footer-group__links']);
    expect(page.heard.sort()).toEqual(['unload b', 'unload c']);
  });

  it("brings a section shown again into its place, even where a group's are all hidden", async () => {
    const page = framed(PAGE.replace(section('b', HOME, 'b'), ''), {
      b: section('b', HOME, 'b', 'Shown again'),
      'footer-group__links': null,
    });
    page.tell({
      type: 'hatti:render',
      sections: ['b', 'footer-group__links'],
      files: { [HOME]: list(['a', 'b', 'c']), [FOOTER]: list(['links'], ['links']) },
    });
    await expect.poll(() => page.told.at(-1)?.type).toBe('hatti:rendered');
    expect(page.ids()).toEqual(['header-group__header', 'a', 'b', 'c']);
    expect(page.document.getElementById('hatti-section-b')!.textContent).toBe('Shown again');
    expect(page.asked).toEqual([
      {
        page: '/',
        sections: ['b', 'footer-group__links'],
        files: { [HOME]: list(['a', 'b', 'c']), [FOOTER]: list(['links'], ['links']) },
      },
    ]);
    expect(page.heard).toEqual(['unload footer-group__links', 'load b']);

    // The footer's one section shown again comes in after where its group starts.
    const links = section('footer-group__links', FOOTER, 'links', 'Links again');
    const again = framed(PAGE.replace(section('footer-group__links', FOOTER, 'links'), ''), {
      'footer-group__links': links,
    });
    again.tell({
      type: 'hatti:render',
      sections: ['footer-group__links'],
      files: { [FOOTER]: list(['links']) },
    });
    await expect.poll(() => again.told.at(-1)?.type).toBe('hatti:rendered');
    expect(again.ids()).toEqual(['header-group__header', 'a', 'b', 'c', 'footer-group__links']);
    expect(again.document.querySelector('footer')!.textContent).toBe('Links again');
  });

  it("renders a section's settings again in its place, moved as its file has it", async () => {
    const page = framed(PAGE, { a: section('a', HOME, 'a', 'New words') });
    const files = { [HOME]: list(['b', 'a', 'c']) };
    page.tell({ type: 'hatti:render', id: 7, sections: ['a'], files });
    await expect.poll(() => page.told.at(-1)?.type).toBe('hatti:rendered');
    // Answered with the id it was asked with, for the editor to know which of its renders it is.
    expect(page.told.at(-1)).toEqual({
      type: 'hatti:rendered',
      id: 7,
      sections: ['a'],
      problems: [],
    });
    expect(page.ids()).toEqual(['header-group__header', 'b', 'a', 'c', 'footer-group__links']);
    expect(page.document.getElementById('hatti-section-a')!.textContent).toBe('New words');
    expect(page.heard).toEqual(['unload a', 'load a', 'reorder b', 'reorder a']);
  });
});
