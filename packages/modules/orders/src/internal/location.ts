import type { FieldError } from '@hatti/api';
import { html, ltr, say, text, type Html, type HtmlValue, type Words } from '@hatti/documents';
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

const WORDS = {
  label: { en: 'Location pin (optional)', ur: 'لوکیشن پن (اختیاری)' },
  add: { en: 'Add my location', ur: 'میری لوکیشن شامل کریں' },
  remove: { en: 'Remove the pin', ur: 'پن ہٹائیں' },
  onTheMap: { en: 'See it on the map', ur: 'نقشے پر دیکھیں' },
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
