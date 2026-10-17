import { html, renderPage, say, type Html, type RenderedPage, type Words } from '@hatti/documents';
import {
  INCIDENT_LIMITS,
  type ComponentHistory,
  type ComponentState,
  type IncidentRecord,
  type IncidentStatus,
  type StatusComponent,
  type StatusSnapshot,
} from './incidents.service.js';
import type { StatusSubscriptionView } from './status-subscriptions.service.js';

// Hatti's status page (ADR-498): whether each of Hatti's parts works, and how it worked each of
// the last 90 days (ADR-528), what is going on and what Hatti has said of it, maintenance to come,
// and what happened lately. In English and Urdu, in Pakistan's time, for shops and their
// customers alike.

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
  emailMe: { en: 'Get these by email', ur: 'یہ ای میل پر پائیں' },
  emailHint: {
    en: 'Hatti emails you each time it says something of an incident or maintenance. Your address is used for nothing else.',
    ur: 'ہٹی جب بھی کسی مسئلے یا مرمت کے بارے میں کچھ بتائے گا، آپ کو ای میل کرے گا۔ آپ کا پتا کسی اور کام میں نہیں آتا۔',
  },
  email: { en: 'Email address', ur: 'ای میل کا پتا' },
  subscribe: { en: 'Email me', ur: 'مجھے ای میل کریں' },
  uptime: {
    en: `Up the last ${INCIDENT_LIMITS.historyDays} days, not counting maintenance posted ahead`,
    ur: `پچھلے ${INCIDENT_LIMITS.historyDays} دن چالو رہا، پہلے سے بتائی گئی مرمت کے سوا`,
  },
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
              </p>
              ${historyBars(snapshot.history.find((each) => each.component === component))}`,
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
      <div class="section">
        <p class="label">${say('bilingual', WORDS.emailMe)}</p>
        <div class="small muted">${both(WORDS.emailHint)}</div>
        <form method="post" action="/status/subscribe">
          <div class="field">
            <label class="label" for="email">${say('bilingual', WORDS.email)}</label>
            <input id="email" name="email" type="email" autocomplete="email" dir="ltr" required />
          </div>
          <button class="button" type="submit">${say('bilingual', WORDS.subscribe)}</button>
        </form>
      </div>
      <div class="small muted">${both(WORDS.times)}</div>
    `,
  });
}

const SUBSCRIPTION_WORDS = {
  title: { en: 'Hatti status emails', ur: 'ہٹی کی صورتحال کی ای میلز' },
  check: {
    en: "If this address isn't getting them yet, a link to confirm is on its way to it. Nothing is sent until it is confirmed.",
    ur: 'اگر یہ پتا ابھی انہیں نہیں پا رہا تو اس پر تصدیق کا لنک آ رہا ہے۔ تصدیق تک کچھ نہیں بھیجا جاتا۔',
  },
  wrong: {
    en: "That isn't an email address: try again.",
    ur: 'یہ ای میل کا پتا نہیں: دوبارہ کوشش کریں۔',
  },
  confirmAsk: {
    en: 'Get an email each time Hatti says something of an incident or maintenance?',
    ur: 'جب بھی ہٹی کسی مسئلے یا مرمت کے بارے میں کچھ بتائے، ای میل پائیں؟',
  },
  confirm: { en: 'Yes, email me', ur: 'ہاں، مجھے ای میل کریں' },
  confirmed: {
    en: "You're getting them. Each email has a link to stop.",
    ur: 'آپ انہیں پا رہے ہیں۔ ہر ای میل میں روکنے کا لنک ہے۔',
  },
  stop: { en: 'Stop these emails', ur: 'یہ ای میلز روکیں' },
  stopped: {
    en: "Stopped: this address won't be emailed again.",
    ur: 'روک دی گئیں: اس پتے پر دوبارہ ای میل نہیں آئے گی۔',
  },
  notFound: {
    en: "This link isn't known: its address may have stopped them already.",
    ur: 'یہ لنک معلوم نہیں: ہو سکتا ہے اس پتے نے انہیں پہلے ہی روک دیا ہو۔',
  },
  back: { en: 'Back to the status page', ur: 'صورتحال کے صفحے پر واپس' },
} satisfies Record<string, Words>;

/** What a page of the status emails says. */
export type StatusSubscriptionState =
  | { kind: 'asked' }
  | { kind: 'wrong' }
  | { kind: 'link'; view: StatusSubscriptionView }
  | { kind: 'stopped' }
  | { kind: 'not_found' };

/**
 * The status emails' pages (ADR-535): after asking, a link's page to confirm or to stop, and
 * what came of either.
 */
export function statusSubscriptionPage(state: StatusSubscriptionState): RenderedPage & {
  status: number;
} {
  const body = (() => {
    switch (state.kind) {
      case 'asked':
        return html`<div class="banner done stack" role="status">
          ${both(SUBSCRIPTION_WORDS.check)}
        </div>`;
      case 'wrong':
        return html`<div class="banner stack" role="alert">${both(SUBSCRIPTION_WORDS.wrong)}</div>`;
      case 'stopped':
        return html`<div class="banner done stack" role="status">
          ${both(SUBSCRIPTION_WORDS.stopped)}
        </div>`;
      case 'not_found':
        return html`<div class="banner stack" role="alert">
          ${both(SUBSCRIPTION_WORDS.notFound)}
        </div>`;
      case 'link':
        return state.view.confirmed
          ? html`<div class="banner done stack" role="status">
                ${both(SUBSCRIPTION_WORDS.confirmed)}
              </div>
              <p class="strong" dir="ltr">${state.view.email}</p>
              <form method="post">
                <input type="hidden" name="action" value="stop" />
                <button class="button secondary" type="submit">
                  ${say('bilingual', SUBSCRIPTION_WORDS.stop)}
                </button>
              </form>`
          : html`<div class="stack">${both(SUBSCRIPTION_WORDS.confirmAsk)}</div>
              <p class="strong" dir="ltr">${state.view.email}</p>
              <form method="post">
                <input type="hidden" name="action" value="confirm" />
                <button class="button" type="submit">
                  ${say('bilingual', SUBSCRIPTION_WORDS.confirm)}
                </button>
              </form>`;
    }
  })();
  const page = renderPage({
    title: SUBSCRIPTION_WORDS.title.en,
    body: html`<h1 class="title stack">${say('bilingual', SUBSCRIPTION_WORDS.title)}</h1>
      ${body}
      <p class="section"><a href="/status">${say('bilingual', SUBSCRIPTION_WORDS.back)}</a></p>`,
  });
  return {
    ...page,
    status: state.kind === 'wrong' ? 422 : state.kind === 'not_found' ? 404 : 200,
  };
}

/**
 * A part's days as a row of bars, the earliest first, each coloured by the worst it was and
 * saying so when pointed at, then its uptime.
 */
function historyBars(history: ComponentHistory | undefined): Html {
  if (!history) return html``;
  const label = `${history.uptime.toFixed(2)}% · ${WORDS.uptime.en}`;
  return html`<div
      class="bars"
      role="img"
      aria-label="${label}"
      data-history="${history.component}"
    >
      ${history.days.map(
        (day) =>
          html`<span
            data-state="${day.state}"
            title="${dayTitle(day.date, day.state, day.downMinutes)}"
          ></span>`,
      )}
    </div>
    <p class="small muted">
      <span class="strong" data-uptime="${history.component}">${history.uptime.toFixed(2)}%</span>
      · ${say('bilingual', WORDS.uptime)}
    </p>`;
}

/** "17 Oct: Down 42 minutes", or "17 Oct: Working". */
function dayTitle(date: string, state: ComponentState, downMinutes: number): string {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T00:00:00Z`));
  // Down at all, the day's worst was down.
  return downMinutes > 0
    ? `${day}: Down ${downMinutes} ${downMinutes === 1 ? 'minute' : 'minutes'}`
    : `${day}: ${STATE_WORDS[state].en}`;
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
    history: snapshot.history,
  };
}
