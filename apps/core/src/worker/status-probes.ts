import type { Logger } from '@hatti/logger';
import {
  COMPONENT_WORDS,
  type IncidentInput,
  type IncidentRecord,
  type IncidentResult,
  type IncidentUpdateInput,
} from '@hatti/trust/public';
import type { StatusProbe } from '../config.js';
import { repeat } from './repeat.js';

/** Who the probes post as, which tells their incidents from Hatti's people's. */
export const PROBE_AUTHOR = "Hatti's checks";

export const PROBE_LIMITS = {
  /** Checks failed in a row before an incident is posted, so one slow answer posts none. */
  failures: 3,
  /** How long a check waits for an answer. */
  timeoutMs: 10_000,
} as const;

/** What the probes need of the incidents. */
export interface ProbeIncidents {
  open(input: IncidentInput, now?: Date): Promise<IncidentResult>;
  update(id: string, input: IncidentUpdateInput, now?: Date): Promise<IncidentResult | 'not_found'>;
  list(): Promise<IncidentRecord[]>;
}

/**
 * Checks each address given for Hatti's parts (BIL-06, ADR-536): a part that fails three checks
 * in a row gets an incident on the status page, down, posted as Hatti's checks; one that answers
 * again has its incident resolved. Incidents Hatti's people post are theirs to end. An answer is
 * any status below 500 within ten seconds: a page that says "not found" still answers.
 */
export class StatusProbes {
  readonly #failures = new Map<string, number>();

  constructor(
    private readonly incidents: ProbeIncidents,
    private readonly probes: readonly StatusProbe[],
    private readonly fetcher: typeof fetch = fetch,
    private readonly logger?: Pick<Logger, 'warn'>,
  ) {}

  /** Checks each part's address at `at`: the incidents posted and resolved. */
  async sweep(at: Date = new Date()): Promise<{ opened: number; resolved: number }> {
    let opened = 0;
    let resolved = 0;
    const open = (await this.incidents.list()).filter(
      (incident) => incident.createdBy === PROBE_AUTHOR && incident.kind === 'incident',
    );
    for (const probe of this.probes) {
      const answered = await this.#check(probe.url);
      const mine = open.find((incident) => incident.components.includes(probe.component));
      const words = COMPONENT_WORDS[probe.component];
      if (answered) {
        this.#failures.delete(probe.url);
        if (!mine) continue;
        const result = await this.incidents.update(
          mine.id,
          {
            status: 'resolved',
            body: `${words.en} answer again, as Hatti's checks find.`,
            bodyUr: `ہٹی کی جانچ کے مطابق ${words.ur} دوبارہ جواب دے رہے ہیں۔`,
            by: PROBE_AUTHOR,
          },
          at,
        );
        if (result !== 'not_found' && result.ok) resolved += 1;
        continue;
      }
      const failures = (this.#failures.get(probe.url) ?? 0) + 1;
      this.#failures.set(probe.url, failures);
      this.logger?.warn({ component: probe.component, failures }, 'status probe failed');
      if (failures < PROBE_LIMITS.failures || mine) continue;
      const result = await this.incidents.open(
        {
          kind: 'incident',
          impact: 'outage',
          components: [probe.component],
          title: `${words.en} not answering`,
          titleUr: `${words.ur} جواب نہیں دے رہے`,
          body: `Hatti's checks find ${words.en.toLowerCase()} not answering. Hatti's people are told, and look into it.`,
          bodyUr: `ہٹی کی جانچ کے مطابق ${words.ur} جواب نہیں دے رہے۔ ہٹی کی ٹیم کو بتا دیا گیا ہے اور وہ دیکھ رہی ہے۔`,
          by: PROBE_AUTHOR,
        },
        at,
      );
      if (result.ok) opened += 1;
    }
    return { opened, resolved };
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'status probes sweep failed'),
    );
  }

  async #check(url: string): Promise<boolean> {
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_LIMITS.timeoutMs),
      });
      await response.body?.cancel();
      return response.status < 500;
    } catch {
      return false;
    }
  }
}
