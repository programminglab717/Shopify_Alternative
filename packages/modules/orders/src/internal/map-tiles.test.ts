import { toMarkup } from '@hatti/documents';
import { describe, expect, it } from 'vitest';
import { MAP_SCRIPT, MapTiles, locationField } from './location.js';

const TEMPLATE = 'https://tiles.example.com/styles/streets/{z}/{x}/{y}.png?key=abc';

/** An element of the little page {@link MAP_SCRIPT} runs on: what it reads and sets, no more. */
class Element {
  hidden = false;
  value = '';
  href = '';
  src = '';
  alt = '';
  draggable = true;
  width = 0;
  height = 0;
  clientWidth = 0;
  clientHeight = 0;
  style: Record<string, string> = {};
  children: Element[] = [];
  focused = false;
  readonly handlers = new Map<string, ((event: unknown) => void)[]>();
  constructor(
    readonly attributes: Record<string, string> = {},
    readonly found: Record<string, Element | Element[]> = {},
  ) {}
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  querySelector(selector: string) {
    const found = this.found[selector];
    return Array.isArray(found) ? (found[0] ?? null) : (found ?? null);
  }
  querySelectorAll(selector: string) {
    const found = this.found[selector];
    return Array.isArray(found) ? found : found ? [found] : [];
  }
  addEventListener(type: string, handler: (event: unknown) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  fire(type: string, event: Record<string, unknown> = {}) {
    for (const handler of this.handlers.get(type) ?? []) {
      handler.call(this, { preventDefault: () => undefined, ...event });
    }
  }
  appendChild(child: Element) {
    this.children.push(child);
  }
  insertBefore(child: Element) {
    this.children.unshift(child);
  }
  removeChild(child: Element) {
    this.children = this.children.filter((each) => each !== child);
  }
  setPointerCapture() {}
  focus() {
    this.focused = true;
  }
}

/** The location field's parts, as the page lays them out, with the map at the pin of Karachi. */
function page() {
  const frame = new Element({
    'data-tiles': TEMPLATE,
    'data-latitude': '24.860700',
    'data-longitude': '67.001100',
    'data-zoom': '17',
  });
  frame.clientWidth = 320;
  frame.clientHeight = 256;
  const latitude = new Element();
  const longitude = new Element();
  const added = new Element({ 'data-show': 'added' });
  added.hidden = true;
  const none = new Element({ 'data-show': 'none' });
  const zoomIn = new Element({ 'data-zoom': '1' });
  const view = new Element({}, { '[data-zoom]': [zoomIn] });
  view.hidden = true;
  const open = new Element();
  open.hidden = true;
  const link = new Element();
  const block = new Element(
    {},
    {
      '[data-tiles]': frame,
      '[data-map-view]': view,
      '[data-open-map]': open,
      'input[name="latitude"]': latitude,
      'input[name="longitude"]': longitude,
      '[data-show]': [added, none],
      '[data-map]': [link],
    },
  );
  const document = {
    querySelector: (selector: string) => (selector === '[data-location]' ? block : null),
    createElement: () => new Element(),
  };
  new Function('document', 'navigator', MAP_SCRIPT)(document, { geolocation: {} });
  return { frame, latitude, longitude, added, none, view, open, link, zoomIn };
}

describe('A map to move the pin on (CHK-02, ADR-719)', () => {
  it("takes a provider's tiles by {z}, {x} and {y} over https, with the words its terms ask for", () => {
    const tiles = new MapTiles(TEMPLATE, '  © OpenStreetMap contributors ');
    expect(tiles.source).toBe('https://tiles.example.com/styles/streets/');
    expect(tiles.attribution).toBe('© OpenStreetMap contributors');
    for (const [template, words] of [
      ['https://tiles.example.com/{z}/{x}.png', 'Tiles'],
      ['https://{s}.tiles.example.com/{z}/{x}/{y}.png', 'Tiles'],
      ['https://tiles{z}.example.com/{x}/{y}.png', 'Tiles'],
      ['http://tiles.example.com/{z}/{x}/{y}.png', 'Tiles'],
      ['tiles.example.com/{z}/{x}/{y}.png', 'Tiles'],
      [TEMPLATE, ' '],
    ] as const) {
      expect(() => new MapTiles(template, words), template).toThrow(/Map tiles/);
    }
  });

  it('lays the map out hidden, on the pin, the city typed or Pakistan', () => {
    const tiles = new MapTiles(TEMPLATE, '© Tiles & co');
    const at = (latitude: string, longitude: string, city: string) =>
      toMarkup(locationField({ latitude, longitude }, [], city, tiles));
    const pinned = at('24.8607', '67.0011', 'Karachi');
    expect(pinned).toContain('data-open-map hidden');
    expect(pinned).toContain('<div data-map-view hidden>');
    expect(pinned).toContain(`data-tiles="${TEMPLATE}"`);
    expect(pinned).toMatch(
      /data-latitude="24.860700"\s+data-longitude="67.001100"\s+data-zoom="17"/,
    );
    expect(pinned).toContain('© Tiles &amp; co');
    expect(pinned).toContain('Put the pin on a map');
    expect(pinned).toContain('نقشے پر پن لگائیں');
    expect(at('', '', 'Lahore')).toMatch(
      /data-latitude="31\.\d+"\s+data-longitude="74\.\d+"\s+data-zoom="13"/,
    );
    expect(at('', '', 'Nowhere')).toMatch(
      /data-latitude="30.000000"\s+data-longitude="70.000000"\s+data-zoom="5"/,
    );
    // Without tiles, no map.
    expect(toMarkup(locationField({ latitude: '', longitude: '' }, [], 'Karachi'))).not.toContain(
      'data-tiles',
    );
  });

  it('puts the pin where the map is moved to, not where it opened or zoomed', () => {
    const { frame, latitude, longitude, added, none, view, open, link, zoomIn } = page();
    expect(open.hidden).toBe(false);
    open.fire('click');
    expect(view.hidden).toBe(false);
    expect(open.hidden).toBe(true);
    expect(frame.focused).toBe(true);
    // The tiles under it, from the provider's template.
    const tiles = frame.children[0]!.children;
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles[0]!.src).toMatch(
      /^https:\/\/tiles\.example\.com\/styles\/streets\/17\/\d+\/\d+\.png\?key=abc$/,
    );
    // Opening it, a tap, or zooming, puts none.
    frame.fire('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
    frame.fire('pointerup');
    zoomIn.fire('click');
    expect(latitude.value).toBe('');
    // Dragged a tile's width west at zoom 18: the pin moves east by 360° over 2^18 tiles.
    frame.fire('pointerdown', { clientX: 300, clientY: 100, pointerId: 1 });
    frame.fire('pointermove', { clientX: 44, clientY: 100 });
    frame.fire('pointerup');
    expect(Number(longitude.value)).toBeCloseTo(67.0011 + 360 / 2 ** 18, 5);
    expect(Number(latitude.value)).toBeCloseTo(24.8607, 5);
    expect(added.hidden).toBe(false);
    expect(none.hidden).toBe(true);
    expect(link.href).toBe(
      `https://www.google.com/maps/search/?api=1&query=${latitude.value},${longitude.value}`,
    );
    // The arrow keys move it too, north.
    frame.fire('keydown', { key: 'ArrowUp' });
    expect(Number(latitude.value)).toBeGreaterThan(24.8607);
  });
});
