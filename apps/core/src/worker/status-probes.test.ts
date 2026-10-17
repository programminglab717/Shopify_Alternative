import type {
  IncidentInput,
  IncidentRecord,
  IncidentResult,
  IncidentUpdateInput,
} from '@hatti/trust/public';
import { describe, expect, it } from 'vitest';
import { PROBE_AUTHOR, StatusProbes, type ProbeIncidents } from './status-probes.js';

const AT = new Date('2026-10-17T09:00:00Z');

/** Incidents kept in memory, as the trust module would keep them. */
class Incidents implements ProbeIncidents {
  readonly records: IncidentRecord[] = [];
  readonly updates: { id: string; input: IncidentUpdateInput }[] = [];

  async open(input: IncidentInput, now = AT): Promise<IncidentResult> {
    const record: IncidentRecord = {
      id: `incident-${this.records.length + 1}`,
      kind: input.kind,
      impact: input.impact,
      components: input.components as IncidentRecord['components'],
      title: input.title,
      titleUr: input.titleUr ?? null,
      startsAt: now,
      endsAt: null,
      resolvedAt: null,
      status: 'investigating',
      createdBy: input.by,
      updates: [],
    };
    this.records.push(record);
    return { ok: true, value: record };
  }

  async update(id: string, input: IncidentUpdateInput, now = AT) {
    const record = this.records.find((each) => each.id === id);
    if (!record) return 'not_found' as const;
    this.updates.push({ id, input });
    if (input.status === 'resolved') record.resolvedAt = now;
    return { ok: true as const, value: record };
  }

  async list(): Promise<IncidentRecord[]> {
    return this.records.filter((each) => each.resolvedAt === null);
  }
}

/** Answers each address with the next of its statuses: a number, or 'down' to fail to answer. */
function answers(script: Record<string, (number | 'down')[]>): typeof fetch {
  return (async (url: string) => {
    const next = script[url]!.shift() ?? 200;
    if (next === 'down') throw new TypeError('fetch failed');
    return new Response(null, { status: next });
  }) as unknown as typeof fetch;
}

describe("Hatti's parts checked, incidents posted when one stops answering (BIL-06, ADR-536)", () => {
  it('posts an outage after three failed checks in a row, once, and resolves it when the part answers', async () => {
    const incidents = new Incidents();
    const fetcher = answers({
      'https://demo.hatti.pk/': [503, 'down', 503, 'down', 200],
      'https://admin.hatti.pk/health': [404, 404, 404, 404, 404],
    });
    const probes = new StatusProbes(
      incidents,
      [
        { component: 'storefronts', url: 'https://demo.hatti.pk/' },
        { component: 'admin', url: 'https://admin.hatti.pk/health' },
      ],
      fetcher,
    );
    expect(await probes.sweep(AT)).toEqual({ opened: 0, resolved: 0 });
    expect(await probes.sweep(AT)).toEqual({ opened: 0, resolved: 0 });
    expect(await probes.sweep(AT)).toEqual({ opened: 1, resolved: 0 });
    expect(incidents.records).toEqual([
      expect.objectContaining({
        kind: 'incident',
        impact: 'outage',
        components: ['storefronts'],
        title: 'Storefronts not answering',
        titleUr: 'آن لائن دکانیں جواب نہیں دے رہے',
        createdBy: PROBE_AUTHOR,
      }),
    ]);
    // Still down: no second incident.
    expect(await probes.sweep(AT)).toEqual({ opened: 0, resolved: 0 });
    // Answering again: resolved, by the checks.
    expect(await probes.sweep(AT)).toEqual({ opened: 0, resolved: 1 });
    expect(incidents.updates).toEqual([
      {
        id: 'incident-1',
        input: expect.objectContaining({ status: 'resolved', by: PROBE_AUTHOR }),
      },
    ]);
  });

  it("starts counting again after an answer, and leaves Hatti's people's incidents to them", async () => {
    const incidents = new Incidents();
    await incidents.open({
      kind: 'incident',
      impact: 'degraded',
      components: ['checkout'],
      title: 'Checkout slow',
      body: 'Looking into it.',
      by: 'Ayesha',
    });
    const fetcher = answers({ 'https://zari.hatti.pk/checkout': [503, 503, 200, 503, 503] });
    const probes = new StatusProbes(
      incidents,
      [{ component: 'checkout', url: 'https://zari.hatti.pk/checkout' }],
      fetcher,
    );
    for (let i = 0; i < 5; i += 1) await probes.sweep(AT);
    // Two failures, an answer, two failures: never three in a row; Ayesha's incident stays open.
    expect(incidents.records).toHaveLength(1);
    expect(incidents.updates).toEqual([]);
  });
});
