import { escapeHtml } from './liquid.js';

// The theme editor's protocol (ADR-050). The editor shows a preview of the theme in a frame; the
// page there is in design mode, and this script in it talks to the editor through postMessage,
// with the origins the storefront allows, each message an object with a `type`:
//
// From the editor, which says hello again each time the frame loads a page:
//   hatti:hello                       answered with hatti:ready
//   hatti:select { section, block? }  scrolls to it, and tells the theme's scripts
//   hatti:deselect
//   hatti:render { id?, sections, files }
//                                     renders those sections of the page again, up to five, with
//                                     the theme's files the editor has not saved yet over the
//                                     saved ones; then the page's sections from each template
//                                     or section group among the files are as it has them: in
//                                     its order, those it hides or no longer has gone, and those
//                                     rendered that were not on the page in their places. With
//                                     no sections, it only puts them in order (ADR-325)
// To the editor:
//   hatti:ready { page, sections }    what the page is: its path, locale and template file, and
//                                     each section's ID, type, file and key, with its blocks
//   hatti:selected { section, block? } the merchant chose it in the page
//   hatti:rendered { id, sections, problems } / hatti:failed { id, message }
//                                     a render's answer, with the id the editor gave it; a
//                                     section the page does not have, to select, fails with none
//
// The theme's own scripts hear Shopify's theme editor events, bubbling from the section or
// block: shopify:section:load, unload, reorder, select and deselect, and shopify:block:select and
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

/** What starts a template's or a section group's sections on the page, before the file's name. */
const LIST_MARK = 'hatti-editor-list ';

/**
 * Where a template's or a section group's sections start on a page in the editor's frame: a
 * comment, which no theme's styles see, for the script to put the sections in order after.
 * Nothing for a name that could end the comment.
 */
export function editorListMark(file: string): string {
  return /^[\w./-]+$/.test(file) ? `<!--${LIST_MARK}${file}-->` : '';
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
  var LIST = ${JSON.stringify(LIST_MARK)};
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

  // Where a template's or a section group's sections start on the page.
  function markOf(file) {
    var walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
    while (walker.nextNode()) {
      if (walker.currentNode.data === LIST + file) return walker.currentNode;
    }
    return null;
  }

  // The page's sections from each of the files that is a template or a section group, as it has
  // them: those it hides or no longer has go, those rendered anew that were not on the page come
  // in, and all follow its order.
  function arrange(files, fresh) {
    Object.keys(files).forEach(function (file) {
      var list = parse(files[file]);
      if (!list || !Array.isArray(list.order) || !list.sections || typeof list.sections !== 'object') return;
      var mark = markOf(file);
      if (!mark) return;
      var found = Object.create(null);
      var was = [];
      var elements = document.querySelectorAll('[data-hatti-editor-section]');
      for (var i = 0; i < elements.length; i++) {
        var place = parse(elements[i].dataset.hattiEditorSection) || {};
        if (place.file !== file || found[place.key]) continue;
        found[place.key] = elements[i];
        was.push(place.key);
      }
      fresh.forEach(function (element) {
        var place = parse(element.dataset.hattiEditorSection) || {};
        if (place.file === file && !found[place.key]) found[place.key] = element;
      });
      var shown = list.order.filter(function (key, index) {
        var placement = list.sections[key];
        return found[key] && placement && !placement.disabled && list.order.indexOf(key) === index;
      });
      Object.keys(found).forEach(function (key) {
        if (shown.indexOf(key) >= 0 || !found[key].isConnected) return;
        fire(found[key], 'section:unload', { sectionId: found[key].id.slice(PREFIX.length) });
        found[key].remove();
      });
      var before = was.filter(function (key) { return shown.indexOf(key) >= 0; });
      var after = shown.filter(function (key) { return before.indexOf(key) >= 0; });
      var at = mark;
      shown.forEach(function (key) {
        var element = found[key];
        var id = element.id.slice(PREFIX.length);
        var arrived = !element.isConnected;
        if (at.nextSibling !== element) at.parentNode.insertBefore(element, at.nextSibling);
        if (arrived) fire(element, 'section:load', { sectionId: id });
        else if (before.indexOf(key) !== after.indexOf(key)) {
          fire(element, 'section:reorder', { sectionId: id });
        }
        at = element;
      });
    });
  }

  function render(ids, files) {
    var asked = ids.length === 0 ? Promise.resolve({}) : fetch('/editor/sections', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hatti-editor': '1' },
      body: JSON.stringify({ page: location.pathname + location.search, sections: ids, files: files }),
    }).then(function (response) {
      if (!response.ok) throw new Error('The preview could not render: ' + response.status);
      return response.json();
    });
    return asked.then(function (answer) {
      var fresh = [];
      ids.forEach(function (id) {
        var holder = document.createElement('div');
        holder.innerHTML = (answer.sections || {})[id] || '';
        var next = holder.firstElementChild;
        var old = sectionOf(id);
        if (!old) {
          // Not on the page: it comes in where its template or group has it.
          if (next) fresh.push(next);
          return;
        }
        fire(old, 'section:unload', { sectionId: id });
        if (next) {
          old.replaceWith(next);
          fire(next, 'section:load', { sectionId: id });
        } else {
          old.remove();
        }
      });
      arrange(files, fresh);
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
      var files = message.files && typeof message.files === 'object' ? message.files : {};
      var asked = message.id;
      render(ids, files).then(
        function (problems) {
          send({ type: 'hatti:rendered', id: asked, sections: ids, problems: problems });
        },
        function (error) { send({ type: 'hatti:failed', id: asked, message: error.message }); }
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
