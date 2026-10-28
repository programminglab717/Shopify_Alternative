import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { MemoryStore } from '@hatti/storefront-data';
import { loadTheme, readThemeDir } from '@hatti/themes';
import { describe, expect, it } from 'vitest';
import { AGE_COOKIE, ageGateScript, ageGateTags } from './age-gate.js';
import { sampleStore } from './fixtures.js';
import { PageRenderer } from './render.js';

const THEME_DIR = fileURLToPath(new URL('../../../themes/hatti-base', import.meta.url));

/** An element of a page in the fake browser: what the gate makes of it. */
class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes: Record<string, string> = {};
  readonly listeners: Record<string, (() => void)[]> = {};
  textContent = '';
  id = '';
  dir = '';
  type = '';
  removed = false;
  focused = false;
  constructor(readonly tag: string) {}
  append(...children: FakeElement[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(type: string, listener: () => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  remove() {
    this.removed = true;
  }
  focus() {
    this.focused = true;
  }
}

/** A page of the shop's in a browser carrying `cookie`, its gate's script run. */
function visit(script: string, cookie = '') {
  const body = new FakeElement('body');
  const classes = new Set<string>();
  const set: string[] = [];
  runInNewContext(script, {
    document: {
      body,
      documentElement: {
        classList: {
          add: (name: string) => classes.add(name),
          remove: (name: string) => classes.delete(name),
        },
      },
      get cookie() {
        return cookie;
      },
      set cookie(value: string) {
        set.push(value);
      },
      createElement: (tag: string) => new FakeElement(tag),
    },
    location: { protocol: 'https:' },
    addEventListener: () => undefined,
    Number,
  });
  const gate = () => body.children.find((child) => child.id === 'hatti-age' && !child.removed);
  const box = () => gate()!.children[0]!;
  const button = (answer: string) =>
    box().children.find((child) => child.attributes['data-age'] === answer && !child.removed);
  return {
    gate,
    box,
    set,
    hidden: () => classes.has('hatti-age-gate'),
    answer: (answer: 'yes' | 'no') => button(answer)!.listeners.click!.forEach((run) => run()),
    button,
  };
}

describe("The shop's age gate (OS-15, ADR-889)", () => {
  it('hides the page and asks, showing it to those who say they are old enough', () => {
    const page = visit(ageGateScript(18, 'en'));
    expect(page.hidden()).toBe(true);
    expect(page.gate()!.attributes).toEqual({
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Age check',
    });
    expect(page.box().children.map((child) => child.textContent)).toEqual([
      'This store is for those 18 or older. Are you 18 or older?',
      'Yes, I am 18 or older',
      'No',
    ]);
    expect(page.button('yes')!.focused).toBe(true);
    page.answer('yes');
    expect(page.gate()).toBeUndefined();
    expect(page.hidden()).toBe(false);
    expect(page.set).toEqual([`${AGE_COOKIE}=18; path=/; max-age=2592000; samesite=lax; secure`]);
  });

  it('keeps the page hidden from those who say they are not, and asks no one twice', () => {
    const page = visit(ageGateScript(21, 'ur'));
    expect(page.gate()!.dir).toBe('rtl');
    page.answer('no');
    expect(page.hidden()).toBe(true);
    const left = page.box().children.filter((child) => !child.removed);
    expect(left.map((child) => child.textContent)).toEqual(['معذرت، یہ اسٹور آپ کے لیے نہیں ہے۔']);
    expect(page.set).toEqual([]);
    // Said they are old enough: not asked again; nor at a lower age; asked again for a higher.
    expect(visit(ageGateScript(21, 'en'), `other=1; ${AGE_COOKIE}=21`).gate()).toBeUndefined();
    expect(visit(ageGateScript(18, 'en'), `${AGE_COOKIE}=21`).gate()).toBeUndefined();
    expect(visit(ageGateScript(21, 'en'), `${AGE_COOKIE}=18`).gate()).toBeDefined();
  });

  it("is on a page only while the shop asks visitors' age", () => {
    expect(ageGateTags(undefined, 'en')).toBe('');
    expect(ageGateTags(18, 'en')).toMatch(/^<style>html\.hatti-age-gate .*<script data-hatti-age>/);
  });

  it("is first in the head of a gated shop's pages, in their language, and of no other shop's", async () => {
    const theme = loadTheme(await readThemeDir(THEME_DIR));
    const head = async (shop: Record<string, unknown>, path = '/') => {
      const sample = sampleStore();
      const store = new MemoryStore({ ...sample, shop: { ...sample.shop, ...shop } });
      const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
      const html = (await renderer.render({ path }, store.fresh(0))).html;
      return html.slice(0, html.indexOf('</head>'));
    };
    const gated = await head({ ageGate: 18, metaPixelId: '1234567890' });
    expect(gated).toContain('<script data-hatti-age>');
    expect(gated.indexOf('<script data-hatti-age>')).toBeLessThan(
      gated.indexOf('<script data-hatti-pixel>'),
    );
    expect(gated).toContain('This store is for those 18 or older.');
    expect(await head({})).not.toContain('data-hatti-age');
  });
});
