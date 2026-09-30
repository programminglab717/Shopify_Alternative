import { escapeHtml } from './liquid.js';

// The theme editor's protocol (ADR-050). The editor shows a preview of the theme in a frame; the
// page there is in design mode, and this script in it talks to the editor through postMessage,
// with the origins the storefront allows, each message an object with a `type`:
//
// From the editor, which says hello again each time the frame loads a page:
//   hatti:hello                       answered with hatti:ready
//   hatti:select { section, block? }  scrolls to it, and tells the theme's scripts
//   hatti:deselect
//   hatti:render { sections, files }  renders those sections of the page again, with the theme's
//                                     files the editor has not saved yet over the saved ones
// To the editor:
//   hatti:ready { page, sections }    what the page is: its path, locale and template file, and
//                                     each section's ID, type, file and key, with its blocks
//   hatti:selected { section, block? } the merchant chose it in the page
//   hatti:rendered { sections, problems } / hatti:failed { message }
//
// The theme's own scripts hear Shopify's theme editor events, bubbling from the section or
// block: shopify:section:load, unload, select and deselect, and shopify:block:select and
// deselect, with `detail` { sectionId, blockId, load }; and `Shopify.designMode` is true.

/** What a design-mode page tells its script: where the editor may be, and the page's template. */
export interface EditorConfig {
  origins: readonly string[];
  template: string | null;
}

/** Where a section's settings are kept, for the editor to change: a file, and its key there. */
export interface EditorPlace {
  file: string;
  key: string;
}

/** An attribute the editor's script finds sections and blocks by: JSON, escaped for HTML. */
export function editorAttribute(name: string, value: Record<string, unknown>): string {
  return `${name}="${escapeHtml(JSON.stringify(value))}"`;
}

/** The styles and script a page in the editor's frame carries in its head. */
export function editorScript(config: EditorConfig): string {
  return (
    '<style>.hatti-editor-selected{outline:2px solid #2563eb;outline-offset:-2px}</style>' +
    `<script data-hatti-editor="${escapeHtml(JSON.stringify(config))}">${BRIDGE}</script>`
  );
}

/** The script itself: classic, so that it knows its own element, and small. */
const BRIDGE = `(function () {
  var config = JSON.parse(document.currentScript.dataset.hattiEditor);
  window.Shopify = window.Shopify || {};
  window.Shopify.designMode = true;
  var PREFIX = 'hatti-section-';
  var editor = null;
  var selected = null;

  function parse(json) {
    try { return JSON.parse(json); } catch (error) { return null; }
  }
  function send(message) {
    if (editor) window.parent.postMessage(message, editor);
  }
  function fire(target, name, detail) {
    target.dispatchEvent(new CustomEvent('shopify:' + name, { bubbles: true, detail: detail }));
  }
  function sectionOf(id) {
    return document.getElementById(PREFIX + id);
  }
  function blockOf(section, id) {
    var blocks = section.querySelectorAll('[data-hatti-editor-block]');
    for (var i = 0; i < blocks.length; i++) {
      var block = parse(blocks[i].dataset.hattiEditorBlock);
      if (block && block.id === id) return blocks[i];
    }
    return null;
  }
  function sections() {
    var found = [];
    var elements = document.querySelectorAll('[data-hatti-editor-section]');
    for (var i = 0; i < elements.length; i++) {
      var section = parse(elements[i].dataset.hattiEditorSection);
      if (!section) continue;
      var blocks = [];
      var marked = elements[i].querySelectorAll('[data-hatti-editor-block]');
      for (var j = 0; j < marked.length; j++) {
        var block = parse(marked[j].dataset.hattiEditorBlock);
        if (block) blocks.push(block);
      }
      section.blocks = blocks;
      found.push(section);
    }
    return found;
  }

  function deselect() {
    if (!selected) return;
    var was = selected;
    selected = null;
    var section = sectionOf(was.section);
    if (!section) return;
    var block = was.block ? blockOf(section, was.block) : null;
    if (block) {
      block.classList.remove('hatti-editor-selected');
      fire(block, 'block:deselect', { sectionId: was.section, blockId: was.block, load: false });
    }
    section.classList.remove('hatti-editor-selected');
    fire(section, 'section:deselect', { sectionId: was.section, load: false });
  }

  function select(sectionId, blockId, load) {
    deselect();
    var section = sectionOf(sectionId);
    if (!section) return false;
    selected = { section: sectionId, block: blockId || null };
    section.classList.add('hatti-editor-selected');
    fire(section, 'section:select', { sectionId: sectionId, load: !!load });
    var shown = section;
    var block = blockId ? blockOf(section, blockId) : null;
    if (block) {
      block.classList.add('hatti-editor-selected');
      fire(block, 'block:select', { sectionId: sectionId, blockId: blockId, load: !!load });
      shown = block;
    }
    shown.scrollIntoView({ block: 'nearest' });
    return true;
  }

  function render(ids, files) {
    return fetch('/editor/sections', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hatti-editor': '1' },
      body: JSON.stringify({ page: location.pathname + location.search, sections: ids, files: files }),
    }).then(function (response) {
      if (!response.ok) throw new Error('The preview could not render: ' + response.status);
      return response.json();
    }).then(function (answer) {
      ids.forEach(function (id) {
        var old = sectionOf(id);
        if (!old) return;
        fire(old, 'section:unload', { sectionId: id });
        var holder = document.createElement('div');
        holder.innerHTML = (answer.sections || {})[id] || '';
        var next = holder.firstElementChild;
        if (next) {
          old.replaceWith(next);
          fire(next, 'section:load', { sectionId: id });
        } else {
          old.remove();
        }
      });
      // Still chosen, as rendered anew: the section it was chosen in is gone.
      if (selected && ids.indexOf(selected.section) >= 0) {
        var again = selected;
        selected = null;
        select(again.section, again.block, true);
      }
      return answer.problems || [];
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || config.origins.indexOf(event.origin) < 0) return;
    var message = event.data || {};
    if (message.type === 'hatti:hello') {
      editor = event.origin;
      send({
        type: 'hatti:ready',
        page: {
          path: location.pathname + location.search,
          locale: document.documentElement.lang,
          template: config.template,
        },
        sections: sections(),
      });
    }
    if (event.origin !== editor) return;
    if (message.type === 'hatti:select') {
      if (!select(String(message.section), message.block ? String(message.block) : null, false)) {
        send({ type: 'hatti:failed', message: 'The page has no section ' + message.section });
      }
    } else if (message.type === 'hatti:deselect') {
      deselect();
    } else if (message.type === 'hatti:render') {
      var ids = Array.isArray(message.sections) ? message.sections.map(String) : [];
      render(ids, message.files || {}).then(
        function (problems) { send({ type: 'hatti:rendered', sections: ids, problems: problems }); },
        function (error) { send({ type: 'hatti:failed', message: error.message }); }
      );
    }
  });

  // What the merchant taps in the page is chosen, unless it is a link or a control, which work
  // as on the storefront.
  document.addEventListener('click', function (event) {
    if (!editor || !event.target.closest) return;
    if (event.target.closest('a[href], button, input, select, textarea, label, summary')) return;
    var section = event.target.closest('[data-hatti-editor-section]');
    if (!section) return;
    var block = event.target.closest('[data-hatti-editor-block]');
    var sectionId = section.id.slice(PREFIX.length);
    var blockId = block && section.contains(block) ? (parse(block.dataset.hattiEditorBlock) || {}).id : null;
    select(sectionId, blockId, false);
    send({ type: 'hatti:selected', section: sectionId, block: blockId || null });
  });
})();`;
