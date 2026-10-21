import type { FieldError } from '@hatti/api';
import {
  html,
  ltr,
  qrCode,
  say,
  text,
  type Html,
  type HtmlValue,
  type Language,
  type Words,
} from '@hatti/documents';
import {
  CITY_REACH_KM,
  distanceKm,
  findCity,
  inPakistan,
  parseDegrees,
  type MapPoint,
} from '@hatti/pk';

// A delivery address's pin (ADR-259): where the customer's phone found them, added on the pages
// that ask for an address by their first script, only when they say they are at the address. The
// rider finds the door by it; a pin from anywhere else would send them astray.

/** An address's pin as a form carries it: degrees as text, both blank for none. */
export interface LocationForm {
  latitude: string;
  longitude: string;
}

/** Where Google Maps shows the pin, on any phone: its app where it has it, else the site. */
export function mapUrlOf(point: MapPoint): string {
  return `https://www.google.com/maps/search/?api=1&query=${point.latitude},${point.longitude}`;
}

/** The form's fields for an address's pin, blank for none. */
export function locationFormOf(point: MapPoint | null | undefined): LocationForm {
  return point
    ? { latitude: point.latitude.toFixed(6), longitude: point.longitude.toFixed(6) }
    : { latitude: '', longitude: '' };
}

/**
 * Finds where the phone is when the customer asks, and keeps it in the form's hidden fields, as
 * {@link locationField} lays them out: the same text on every page, which their policy allows by
 * its hash. A fix further than 500 m out, as from the network's address alone, is not kept: the
 * rider would knock at the wrong door. Without it, or without the phone's location, the page
 * shows nothing of the pin.
 */
export const LOCATION_SCRIPT = `(function () {
  var block = document.querySelector('[data-location]');
  if (!block || !navigator.geolocation) return;
  var latitude = block.querySelector('input[name="latitude"]');
  var longitude = block.querySelector('input[name="longitude"]');
  function show(state) {
    var parts = block.querySelectorAll('[data-show]');
    for (var i = 0; i < parts.length; i++) {
      parts[i].hidden = parts[i].getAttribute('data-show').split(' ').indexOf(state) < 0;
    }
  }
  function found(position) {
    var coords = position.coords;
    if (coords.accuracy > 500) return show('rough');
    latitude.value = coords.latitude.toFixed(6);
    longitude.value = coords.longitude.toFixed(6);
    var links = block.querySelectorAll('[data-map]');
    for (var i = 0; i < links.length; i++) {
      links[i].href = 'https://www.google.com/maps/search/?api=1&query=' +
        latitude.value + ',' + longitude.value;
    }
    show('added');
  }
  block.querySelector('[data-add]').addEventListener('click', function () {
    show('finding');
    navigator.geolocation.getCurrentPosition(found, function (error) {
      show(error.code === 1 ? 'denied' : 'failed');
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
  block.querySelector('[data-remove]').addEventListener('click', function () {
    latitude.value = '';
    longitude.value = '';
    show('none');
  });
  block.hidden = false;
})();`;

/**
 * The map tiles a page's map to move the pin on is drawn from (ADR-719): a provider's raster
 * tiles, 256 pixels square in Web Mercator, by a template such as
 * "https://tiles.example.com/{z}/{x}/{y}.png?key=…", and the words its terms ask the map to show.
 * Provided by the host application from its configuration; without it, no map is drawn.
 */
export class MapTiles {
  readonly template: string;
  readonly attribution: string;
  /** Where the tiles are, for a page's policy: the template's address up to its first placeholder. */
  readonly source: string;

  constructor(template: string, attribution: string) {
    const placeholders: string[] = template.match(/\{[^}]*\}/g) ?? [];
    if (!['{z}', '{x}', '{y}'].every((each) => placeholders.includes(each))) {
      throw new Error('Map tiles need {z}, {x} and {y} in their template');
    }
    if (placeholders.some((each) => !['{z}', '{x}', '{y}'].includes(each))) {
      throw new Error('Map tiles take no placeholders but {z}, {x} and {y}');
    }
    const prefix = template.slice(0, template.indexOf('{'));
    const source = prefix.slice(0, prefix.lastIndexOf('/') + 1);
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new Error(`Map tiles must be at an https URL: ${template}`);
    }
    if (url.protocol !== 'https:' || !source.startsWith(`${url.origin}/`)) {
      throw new Error(
        `Map tiles must be at an https URL, their placeholders after its host: ${template}`,
      );
    }
    const words = attribution.trim();
    if (words.length === 0 || words.length > 200) {
      throw new Error(
        'Map tiles need the words their terms ask maps to show, up to 200 characters',
      );
    }
    this.template = template;
    this.attribution = words;
    this.source = source;
  }
}

/** How close the map opens, on the pin, on the city typed, or on Pakistan. */
const MAP_ZOOM = { pin: 17, city: 13, country: 5 } as const;

/** Where the map opens without a pin or a city it knows: Pakistan, whole. */
const PAKISTAN: MapPoint = { latitude: 30.0, longitude: 70.0 };

/**
 * Draws the map {@link locationField} lays out when given {@link MapTiles} (ADR-719), once the
 * customer asks for it: its tiles under a pin that stays at its centre, moved by dragging, or by
 * the arrow keys, and zoomed by its buttons or the + and - keys. Moving it puts the pin where it
 * now points, in the form's hidden fields as {@link LOCATION_SCRIPT} would; opening it or zooming
 * alone puts none. The same text on every page, which their policy allows by its hash, with the
 * tiles' source among its images. Without it, the map stays hidden.
 */
export const MAP_SCRIPT = `(function () {
  var block = document.querySelector('[data-location]');
  var frame = block && block.querySelector('[data-tiles]');
  if (!frame || !navigator.geolocation) return;
  var SIZE = 256, MIN = 5, MAX = 19, STEP = 64;
  var view = block.querySelector('[data-map-view]');
  var open = block.querySelector('[data-open-map]');
  var latitude = block.querySelector('input[name="latitude"]');
  var longitude = block.querySelector('input[name="longitude"]');
  var template = frame.getAttribute('data-tiles');
  var zoom = Number(frame.getAttribute('data-zoom'));
  var centre = project(Number(frame.getAttribute('data-latitude')),
    Number(frame.getAttribute('data-longitude')));
  var layer = document.createElement('div');
  var tiles = {};
  frame.insertBefore(layer, frame.firstChild);
  function world() { return SIZE * Math.pow(2, zoom); }
  function project(lat, lng) {
    var sin = Math.sin(lat * Math.PI / 180);
    return { x: (lng + 180) / 360 * world(),
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world() };
  }
  function unproject(point) {
    var n = Math.PI - 2 * Math.PI * point.y / world();
    return { latitude: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
      longitude: point.x / world() * 360 - 180 };
  }
  function draw() {
    var width = frame.clientWidth, height = frame.clientHeight, count = Math.pow(2, zoom);
    centre.y = Math.max(height / 2, Math.min(world() - height / 2, centre.y));
    var left = centre.x - width / 2, top = centre.y - height / 2, kept = {};
    for (var x = Math.floor(left / SIZE); x <= Math.floor((left + width) / SIZE); x++) {
      for (var y = Math.max(0, Math.floor(top / SIZE));
        y <= Math.min(count - 1, Math.floor((top + height) / SIZE)); y++) {
        var key = zoom + '/' + x + '/' + y;
        var tile = tiles[key];
        if (!tile) {
          tile = document.createElement('img');
          tile.alt = '';
          tile.draggable = false;
          tile.width = SIZE;
          tile.height = SIZE;
          tile.src = template.split('{z}').join(zoom)
            .split('{x}').join(((x % count) + count) % count).split('{y}').join(y);
          layer.appendChild(tile);
          tiles[key] = tile;
        }
        tile.style.left = (x * SIZE - left) + 'px';
        tile.style.top = (y * SIZE - top) + 'px';
        kept[key] = true;
      }
    }
    for (var each in tiles) {
      if (!kept[each]) { layer.removeChild(tiles[each]); delete tiles[each]; }
    }
  }
  function show(state) {
    var parts = block.querySelectorAll('[data-show]');
    for (var i = 0; i < parts.length; i++) {
      parts[i].hidden = parts[i].getAttribute('data-show').split(' ').indexOf(state) < 0;
    }
  }
  function pin() {
    var point = unproject(centre);
    latitude.value = point.latitude.toFixed(6);
    longitude.value = point.longitude.toFixed(6);
    var links = block.querySelectorAll('[data-map]');
    for (var i = 0; i < links.length; i++) {
      links[i].href = 'https://www.google.com/maps/search/?api=1&query=' +
        latitude.value + ',' + longitude.value;
    }
    show('added');
  }
  function move(dx, dy) {
    centre.x += dx;
    centre.y += dy;
    draw();
  }
  function zoomBy(step) {
    var point = unproject(centre);
    zoom = Math.max(MIN, Math.min(MAX, zoom + step));
    centre = project(point.latitude, point.longitude);
    draw();
  }
  var from = null, moved = 0;
  frame.addEventListener('pointerdown', function (event) {
    from = { x: event.clientX, y: event.clientY };
    moved = 0;
    frame.setPointerCapture(event.pointerId);
  });
  frame.addEventListener('pointermove', function (event) {
    if (!from) return;
    var dx = event.clientX - from.x, dy = event.clientY - from.y;
    moved += Math.abs(dx) + Math.abs(dy);
    from = { x: event.clientX, y: event.clientY };
    move(-dx, -dy);
  });
  function end() {
    if (!from) return;
    from = null;
    if (moved > 3) pin();
  }
  frame.addEventListener('pointerup', end);
  frame.addEventListener('pointercancel', end);
  frame.addEventListener('keydown', function (event) {
    var keys = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP],
      ArrowDown: [0, STEP] };
    if (keys[event.key]) {
      move(keys[event.key][0], keys[event.key][1]);
      pin();
    } else if (event.key === '+' || event.key === '=') {
      zoomBy(1);
    } else if (event.key === '-') {
      zoomBy(-1);
    } else {
      return;
    }
    event.preventDefault();
  });
  var buttons = view.querySelectorAll('[data-zoom]');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function () {
      zoomBy(Number(this.getAttribute('data-zoom')));
    });
  }
  open.addEventListener('click', function () {
    open.removeAttribute('data-show');
    open.hidden = true;
    view.hidden = false;
    draw();
    frame.focus();
  });
  open.hidden = false;
})();`;

const WORDS = {
  label: { en: 'Location pin (optional)', ur: 'لوکیشن پن (اختیاری)' },
  add: { en: 'Add my location', ur: 'میری لوکیشن شامل کریں' },
  remove: { en: 'Remove the pin', ur: 'پن ہٹائیں' },
  onTheMap: { en: 'See it on the map', ur: 'نقشے پر دیکھیں' },
  pin: { en: 'Location pin', ur: 'لوکیشن پن' },
  openMap: { en: 'Put the pin on a map', ur: 'نقشے پر پن لگائیں' },
  zoomIn: { en: 'Zoom in', ur: 'زوم اِن' },
  zoomOut: { en: 'Zoom out', ur: 'زوم آؤٹ' },
  map: {
    en: 'Map of the delivery address: drag it, or use the arrow keys, to put the pin on the door',
    ur: 'ڈیلیوری کے پتے کا نقشہ: پن کو دروازے پر لانے کے لیے اسے کھینچیں، یا تیر والی کلیدیں استعمال کریں',
  },
  scan: {
    en: "Scan it for the way to the customer's door",
    ur: 'گاہک کے دروازے تک راستے کے لیے اسکین کریں',
  },
} satisfies Record<string, Words>;

interface Sentence {
  en: HtmlValue;
  ur: HtmlValue;
}

const SAY = {
  none: {
    en: 'At the delivery address now? Add your location, so the rider finds your door.',
    ur: 'کیا آپ ابھی ڈیلیوری کے پتے پر ہیں؟ اپنی لوکیشن شامل کریں تاکہ رائیڈر آپ کا دروازہ ڈھونڈ سکے۔',
  },
  finding: {
    en: 'Finding your location…',
    ur: 'آپ کی لوکیشن معلوم کی جا رہی ہے…',
  },
  denied: {
    en: "Your browser didn't share your location. To add it, allow location for this page in its settings.",
    ur: 'آپ کے براؤزر نے لوکیشن شیئر نہیں کی۔ اسے شامل کرنے کے لیے براؤزر کی سیٹنگز میں اس صفحے کو لوکیشن کی اجازت دیں۔',
  },
  rough: {
    en: "Your location couldn't be found closely enough. Turn on your phone's location, then try again.",
    ur: 'آپ کی لوکیشن ٹھیک سے معلوم نہیں ہو سکی۔ فون کی لوکیشن آن کریں، پھر دوبارہ کوشش کریں۔',
  },
  onMap: {
    en: 'Move the map until the pin is on your door. Zoom in to see your street.',
    ur: 'نقشے کو سرکائیں یہاں تک کہ پن آپ کے دروازے پر آ جائے۔ اپنی گلی دیکھنے کے لیے زوم اِن کریں۔',
  },
  failed: {
    en: "Your location couldn't be found. Try again, or leave it out.",
    ur: 'آپ کی لوکیشن معلوم نہیں ہو سکی۔ دوبارہ کوشش کریں، یا اسے چھوڑ دیں۔',
  },
  abroad: {
    en: "This pin isn't in Pakistan. Remove it, or add it again at the delivery address.",
    ur: 'یہ پن پاکستان میں نہیں ہے۔ اسے ہٹائیں، یا ڈیلیوری کے پتے پر دوبارہ شامل کریں۔',
  },
  unread: {
    en: "This pin couldn't be read. Remove it, or add it again.",
    ur: 'یہ پن پڑھا نہیں جا سکا۔ اسے ہٹائیں، یا دوبارہ شامل کریں۔',
  },
} satisfies Record<string, Sentence>;

/**
 * The pin of the address a form asks for (ADR-259): hidden until {@link LOCATION_SCRIPT} runs,
 * on a phone that can say where it is, then a button that adds where it is, saying what came of
 * it. A pin the form carries already shows as added, with a way to see it on the map; one that
 * did not check out says why, the form's `city` its words where the pin is far from it.
 */
export function locationField(
  form: LocationForm,
  errors: readonly FieldError[],
  city: string,
  tiles?: MapTiles | null,
): Html {
  const error = errors.find((each) => ['latitude', 'longitude'].includes(each.field[0] ?? ''));
  const latitude = form.latitude.trim() === '' ? null : parseDegrees(form.latitude);
  const longitude = form.longitude.trim() === '' ? null : parseDegrees(form.longitude);
  const point = latitude !== null && longitude !== null ? { latitude, longitude } : null;
  const state = error ? 'error' : point ? 'added' : 'none';
  const part = (states: string, content: Html) =>
    html`<div data-show="${states}" ${!states.split(' ').includes(state) && html`hidden`}>
      ${content}
    </div>`;
  const map = point ? mapUrlOf(point) : '#';
  const mapLink = (words: string) =>
    html`<a href="${map}" data-map target="_blank" rel="noreferrer">${words}</a>`;
  return html`<div class="field" data-location aria-live="polite" hidden>
    <p class="label">${say('bilingual', WORDS.label)}</p>
    <input type="hidden" name="latitude" value="${form.latitude}" />
    <input type="hidden" name="longitude" value="${form.longitude}" />
    ${part('none', paragraphs(SAY.none, 'small muted'))}
    ${part('finding', paragraphs(SAY.finding, 'small muted'))}
    ${part(
      'added',
      paragraphs(
        {
          en: html`Your location is added. ${mapLink(WORDS.onTheMap.en)}.`,
          ur: html`آپ کی لوکیشن شامل ہو گئی ہے۔ ${mapLink(WORDS.onTheMap.ur)}۔`,
        },
        'small',
      ),
    )}
    ${part('denied', paragraphs(SAY.denied, 'error'))}
    ${part('rough', paragraphs(SAY.rough, 'error'))}
    ${part('failed', paragraphs(SAY.failed, 'error'))}
    ${error && part('error', paragraphs(pinProblem(point, city), 'error'))}
    <button
      class="button secondary"
      type="button"
      data-add
      data-show="none denied rough failed error"
      ${state === 'added' && html`hidden`}
    >
      ${say('bilingual', WORDS.add)}
    </button>
    <button
      class="button secondary"
      type="button"
      data-remove
      data-show="added"
      ${state !== 'added' && html`hidden`}
    >
      ${say('bilingual', WORDS.remove)}
    </button>
    ${tiles && mapView(tiles, point, city)}
  </div>`;
}

/**
 * The map to move the pin on (ADR-719), as {@link MAP_SCRIPT} draws it: hidden, with the button
 * that opens it, until it runs. It opens on the pin, else on the city typed, else on Pakistan.
 */
function mapView(tiles: MapTiles, point: MapPoint | null, city: string): Html {
  const known = point ? null : findCity(city);
  const [centre, zoom] = point
    ? [point, MAP_ZOOM.pin]
    : known
      ? [known.centre, MAP_ZOOM.city]
      : [PAKISTAN, MAP_ZOOM.country];
  return html`<button class="button secondary" type="button" data-open-map hidden>
      ${say('bilingual', WORDS.openMap)}
    </button>
    <div data-map-view hidden>
      ${paragraphs(SAY.onMap, 'small muted')}
      <div
        class="map"
        data-tiles="${tiles.template}"
        data-latitude="${centre.latitude.toFixed(6)}"
        data-longitude="${centre.longitude.toFixed(6)}"
        data-zoom="${zoom}"
        tabindex="0"
        role="application"
        aria-label="${`${WORDS.map.en} / ${WORDS.map.ur}`}"
      >
        <span class="map-pin" aria-hidden="true"></span>
      </div>
      <div class="zoom">
        <button
          class="button secondary"
          type="button"
          data-zoom="1"
          aria-label="${WORDS.zoomIn.en}"
        >
          +
        </button>
        <button
          class="button secondary"
          type="button"
          data-zoom="-1"
          aria-label="${WORDS.zoomOut.en}"
        >
          −
        </button>
      </div>
      <p class="small muted" dir="ltr">${tiles.attribution}</p>
    </div>`;
}

/**
 * The pin's line on a page that shows the address: a link to it on the map. Nothing for an
 * address without one.
 */
export function pinLine(point: MapPoint | null | undefined): Html | false {
  return (
    !!point &&
    html`<a href="${mapUrlOf(point)}" target="_blank" rel="noreferrer"
      >${say('bilingual', { en: 'Location pin on the map', ur: 'نقشے پر لوکیشن پن' })}</a
    >`
  );
}

/**
 * The pin on a printed packing slip or label (ADR-628): a QR code of its address on the map, for
 * the rider to scan with a phone's camera and be shown the way. Nothing for an address without one.
 */
export function pinCode(point: MapPoint | null | undefined, language: Language): Html | false {
  return (
    !!point &&
    html`<section class="pin">
      ${qrCode(mapUrlOf(point), 'Location pin on the map')}
      <div>
        <p class="label">${say(language, WORDS.pin)}</p>
        <p class="small">${say(language, WORDS.scan)}</p>
      </div>
    </section>`
  );
}

/** Why a pin was not kept: not in Pakistan, too far from the city typed, or not read at all. */
function pinProblem(point: MapPoint | null, city: string): Sentence {
  if (!point) return SAY.unread;
  if (!inPakistan(point)) return SAY.abroad;
  const known = findCity(city);
  const away = known ? distanceKm(point, known.centre) : 0;
  if (!known || away <= CITY_REACH_KM) return SAY.unread;
  const km = `${Math.round(away).toLocaleString('en-US')} km`;
  const only = 'اسے صرف ڈیلیوری کے پتے پر شامل کریں، یا ہٹا دیں۔';
  return {
    en: `This pin is ${km} from ${known.name}. Add it only at the delivery address, or remove it.`,
    ur: html`یہ پن ${text(known.nameUr)} سے ${ltr(km)} دور ہے۔ ${only}`,
  };
}

function paragraphs(sentence: Sentence, className: string): Html {
  return html`<div class="text ${className}">
    <p lang="en">${sentence.en}</p>
    <p lang="ur" dir="rtl">${sentence.ur}</p>
  </div>`;
}
