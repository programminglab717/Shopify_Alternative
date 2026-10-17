import { html, renderPage, say, type Html, type RenderedPage, type Words } from '@hatti/documents';
import {
  INCIDENT_LIMITS,
  type ComponentState,
  type IncidentRecord,
  type IncidentStatus,
  type StatusComponent,
  type StatusSnapshot,
} from './incidents.service.js';

// Hatti's status page (ADR-498): whether each of Hatti's parts works, what is going on and what
// Hatti has said of it, maintenance to come, and what happened lately. In English and Urdu, in
// Pakistan's time, for shops and their customers alike.

/** Pakistan's: the page's times are in it, and say so. */
const TIME_ZONE = 'Asia/Karachi';

export const COMPONENT_WORDS: Record<StatusComponent, Words> = {
  storefronts: { en: 'Storefronts', ur: 'آن لائن دکانیں' },
  checkout: { en: 'Checkout', ur: 'چیک آؤٹ' },
  admin: { en: 'Admin', ur: 'ایڈمن' },
  payments: { en: 'Online payments', ur: 'آن لائن ادائیگیاں' },
  couriers: { en: 'Courier bookings and tracking', ur: 'کورئیر بکنگ اور ٹریکنگ' },
  whatsapp: { en: 'WhatsApp messages', ur: 'واٹس ایپ پیغامات' },
  sms: { en: 'SMS', ur: 'ایس ایم ایس' },
  email: { en: 'Email', ur: 'ای میل' },
};

const STATE_WORDS: Record<ComponentState, Words> = {
  operational: { en: 'Working', ur: 'ٹھیک کام کر رہا ہے' },
  maintenance: { en: 'Maintenance', ur: 'مرمت جاری' },
  degraded: { en: 'Slow or partly down', ur: 'سست یا جزوی طور پر بند' },
  outage: { en: 'Down', ur: 'بند' },
};

const OVERALL_WORDS: Record<ComponentState, Words> = {
  operational: { en: 'Everything is working', ur: 'سب کچھ ٹھیک کام کر رہا ہے' },
  maintenance: { en: 'Maintenance is under way', ur: 'مرمت جاری ہے' },
  degraded: {
    en: 'Some of Hatti is slow or partly down',
    ur: 'ہٹی کے کچھ حصے سست یا جزوی طور پر بند ہیں',
  },
  outage: { en: 'Some of Hatti is down', ur: 'ہٹی کے کچھ حصے بند ہیں' },
};

export const STATUS_WORDS: Record<IncidentStatus, Words> = {
  investigating: { en: 'Investigating', ur: 'جانچ جاری ہے' },
  identified: { en: 'Cause found', ur: 'وجہ مل گئی' },
  monitoring: { en: 'Fixed, watching', ur: 'ٹھیک کر دیا، نگرانی جاری' },
  resolved: { en: 'Resolved', ur: 'حل ہو گیا' },
  scheduled: { en: 'Scheduled', ur: 'طے شدہ' },
  in_progress: { en: 'Under way', ur: 'جاری' },
  completed: { en: 'Completed', ur: 'مکمل' },
};

const WORDS = {
  title: { en: 'Hatti status', ur: 'ہٹی کی صورتحال' },
  parts: { en: "Hatti's parts", ur: 'ہٹی کے حصے' },
  now: { en: 'Going on now', ur: 'اس وقت جاری' },
  coming: { en: 'Maintenance to come', ur: 'آنے والی مرمت' },
  recent: {
    en: `The last ${INCIDENT_LIMITS.recentDays} days`,
    ur: `پچھلے ${INCIDENT_LIMITS.recentDays} دن`,
  },
  nothingRecent: {
    en: `Nothing happened in the last ${INCIDENT_LIMITS.recentDays} days.`,
    ur: `پچھلے ${INCIDENT_LIMITS.recentDays} دنوں میں کچھ نہیں ہوا۔`,
  },
  touches: { en: 'Touches', ur: 'متاثر' },
  until: { en: 'until', ur: 'تک' },
  ended: { en: 'Ended', ur: 'ختم' },
  times: { en: 'Times are Pakistan time (PKT).', ur: 'اوقات پاکستان کے وقت کے مطابق ہیں۔' },
} satisfies Record<string, Words>;

/** "17 Oct, 2:30 pm", in Pakistan's time. */
export function statusTime(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('day')} ${part('month')}, ${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase()}`;
}

/** The status page as `snapshot` has it. */
export function statusPage(snapshot: StatusSnapshot): RenderedPage {
  return renderPage({
    title: `${WORDS.title.en} · ${OVERALL_WORDS[snapshot.overall].en}`,
    body: html`
      <h1 class="title stack">${say('bilingual', WORDS.title)}</h1>
      <div class="banner stack${snapshot.overall === 'operational' ? ' done' : ''}" role="status">
        ${both(OVERALL_WORDS[snapshot.overall])}
      </div>
      <div class="section">
        <p class="label">${say('bilingual', WORDS.parts)}</p>
        ${snapshot.components.map(
          ({ component, state }) =>
            html`<p class="stack" data-component="${component}" data-state="${state}">
              ${say('bilingual', COMPONENT_WORDS[component])} ·
              <span class="${state === 'operational' ? 'muted' : 'strong'}"
                >${say('bilingual', STATE_WORDS[state])}</span
              >
            </p>`,
        )}
      </div>
      ${
        snapshot.active.length > 0 &&
        html`<div class="section">
          <p class="label">${say('bilingual', WORDS.now)}</p>
          ${snapshot.active.map((incident) => incidentBlock(incident))}
        </div>`
      }
      ${
        snapshot.upcoming.length > 0 &&
        html`<div class="section">
          <p class="label">${say('bilingual', WORDS.coming)}</p>
          ${snapshot.upcoming.map((incident) => incidentBlock(incident))}
        </div>`
      }
      <div class="section">
        <p class="label">${say('bilingual', WORDS.recent)}</p>
        ${
          snapshot.recent.length === 0
            ? html`<div class="muted">${both(WORDS.nothingRecent)}</div>`
            : snapshot.recent.map((incident) => incidentBlock(incident))
        }
      </div>
      <div class="small muted">${both(WORDS.times)}</div>
    `,
  });
}

function incidentBlock(incident: IncidentRecord): Html {
  const when = incident.resolvedAt
    ? html`${say('bilingual', WORDS.ended)} ${statusTime(incident.resolvedAt)}`
    : html`${statusTime(incident.startsAt)}
      ${incident.endsAt && html` ${say('english', WORDS.until)} ${statusTime(incident.endsAt)}`}`;
  return html`<div class="section" data-incident="${incident.id}">
    <h2 class="strong" lang="en">${incident.title}</h2>
    ${incident.titleUr && html`<p class="strong" lang="ur" dir="rtl">${incident.titleUr}</p>`}
    <p class="small muted">${when}</p>
    <p class="small">
      ${say('bilingual', WORDS.touches)}:
      ${incident.components.map((component) => COMPONENT_WORDS[component].en).join(', ')}
    </p>
    ${[...incident.updates].reverse().map(
      (update) =>
        html`<div class="text">
          <p class="small">
            <span class="strong">${say('bilingual', STATUS_WORDS[update.status])}</span> ·
            ${statusTime(update.postedAt)}
          </p>
          <p lang="en">${update.body}</p>
          ${update.bodyUr && html`<p lang="ur" dir="rtl">${update.bodyUr}</p>`}
        </div>`,
    )}
  </div>`;
}

function both(words: Words): Html {
  return html`<p lang="en">${words.en}</p>
    <p lang="ur" dir="rtl">${words.ur}</p>`;
}

/** The status page's JSON, for monitors and anyone else: the same, with times in ISO 8601. */
export function statusJson(snapshot: StatusSnapshot): object {
  const incident = (each: IncidentRecord) => ({
    id: each.id,
    kind: each.kind,
    impact: each.impact,
    status: each.status,
    components: each.components,
    title: each.title,
    titleUr: each.titleUr,
    startsAt: each.startsAt.toISOString(),
    endsAt: each.endsAt?.toISOString() ?? null,
    resolvedAt: each.resolvedAt?.toISOString() ?? null,
    updates: each.updates.map((update) => ({
      status: update.status,
      body: update.body,
      bodyUr: update.bodyUr,
      postedAt: update.postedAt.toISOString(),
    })),
  });
  return {
    overall: snapshot.overall,
    components: snapshot.components,
    active: snapshot.active.map(incident),
    upcoming: snapshot.upcoming.map(incident),
    recent: snapshot.recent.map(incident),
  };
}
