import { writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '@hatti/storefront-data';
import { sampleStore } from '../fixtures.js';
import { PageRenderer, type PageRequest } from '../render.js';
import { loadTheme, readThemeDir, type ThemeFiles } from '../theme.js';

// Spike 1's benchmark: renders Hatti Base's pages from the sample shop as the storefront would,
// and reports what they take (docs/engineering/spikes/01-liquid-rendering.md).
//   pnpm bench:storefront [-- --write docs/engineering/spikes/01-benchmark-output.md]

const RUNS = 500;
const WARM_UP = 50;

const PAGES: { name: string; request: PageRequest }[] = [
  { name: 'Home', request: { path: '/' } },
  { name: 'Home, Urdu', request: { path: '/', locale: 'ur' } },
  { name: 'Product (lawn suit, 6 variants)', request: { path: '/products/' } },
  {
    name: 'Product (100 variants, 10 images)',
    request: { path: '/products/bridal-lehenga-heavy' },
  },
  { name: 'Collection, 24 a page', request: { path: '/collections/eid-lawn' } },
];

const themeDir = fileURLToPath(new URL('../../../../themes/hatti-base', import.meta.url));
const files = await readThemeDir(themeDir);
const theme = loadTheme(files);
const documents = sampleStore();
PAGES[2]!.request = { path: `/products/${documents.products[0]!.handle}` };
const lines: string[] = [];
const out = (line = '') => {
  lines.push(line);
  console.log(line);
};

out('# Spike 1 · Benchmark output');
out();
out(
  `Node ${process.version}, ${cpus()[0]?.model ?? 'unknown CPU'} (${cpus().length} cores), ` +
    `one process. Hatti Base (${Object.keys(files).length} files), the sample shop ` +
    `(${documents.products.length} products). ${RUNS} renders a page after ${WARM_UP} to warm up.`,
);

// A. Pages on their own, data in memory: what rendering itself costs.
out();
out('## A. Rendering alone (data in memory)');
out();
out('| Page | p50 ms | p95 ms | p99 ms | max ms | CPU ms | Output KB | Nodes | Round trips |');
out('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const page of PAGES) {
  const result = await measure(new PageRenderer(theme), page.request, 0);
  out(
    `| ${page.name} | ${f(result.p50)} | ${f(result.p95)} | ${f(result.p99)} | ${f(result.max)} | ` +
      `${f(result.cpu)} | ${f(result.kb, 0)} | ${result.nodes} | ${result.roundTrips} |`,
  );
}

// B. With a round trip to Valkey taking a millisecond, as inside a cell.
out();
out(
  '## B. With 1 ms a round trip: sections side by side or in turn, products by the chunk or one by one',
);
out();
out(
  '| Page | Side by side p50 | p95 | In turn p50 | p95 | One by one p50 | p95 | Round trips one by one |',
);
out('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const page of PAGES) {
  const together = await measure(new PageRenderer(theme), page.request, 1);
  const inTurn = await measure(new PageRenderer(theme, { concurrent: false }), page.request, 1);
  const single = await measure(new PageRenderer(theme, { chunkSize: 1 }), page.request, 1);
  out(
    `| ${page.name} | ${f(together.p50)} | ${f(together.p95)} | ${f(inTurn.p50)} | ` +
      `${f(inTurn.p95)} | ${f(single.p50)} | ${f(single.p95)} | ${single.roundTrips} |`,
  );
}

// C. The first render of a theme version, which parses its templates.
out();
out('## C. First render of a theme version (parsing included)');
out();
out('| Page | Median of 20 ms | Parse the whole theme ms |');
out('|---|---:|---:|');
for (const page of PAGES) {
  const firsts: number[] = [];
  const parses: number[] = [];
  for (let run = 0; run < 20; run += 1) {
    const fresh = loadTheme(files);
    const started = performance.now();
    new PageRenderer(fresh).check();
    parses.push(performance.now() - started);
    const renderer = new PageRenderer(fresh);
    const first = performance.now();
    await renderer.render(page.request, new MemoryStore(documents));
    firsts.push(performance.now() - first);
  }
  out(`| ${page.name} | ${f(median(firsts))} | ${f(median(parses))} |`);
}

// D. Many requests at once, on one core.
out();
out('## D. Under load: requests at a time for 5 s, 1 ms a round trip, pages mixed');
out();
out(`| At a time | Pages a second | p50 ms | p95 ms | p99 ms | CPU busy |`);
out('|---:|---:|---:|---:|---:|---:|');
for (const inFlight of [8, 64]) {
  const renderer = new PageRenderer(theme);
  const store = new MemoryStore(documents, 1);
  const times: number[] = [];
  const until = performance.now() + 5_000;
  const cpuBefore = process.cpuUsage();
  let served = 0;
  const worker = async (seed: number) => {
    for (let index = seed; performance.now() < until; index += 1) {
      const started = performance.now();
      await renderer.render(PAGES[index % PAGES.length]!.request, store.fresh());
      times.push(performance.now() - started);
      served += 1;
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: inFlight }, (_, seed) => worker(seed)));
  const seconds = (performance.now() - started) / 1000;
  const cpu = process.cpuUsage(cpuBefore);
  times.sort((a, b) => a - b);
  out(
    `| ${inFlight} | ${f(served / seconds, 0)} | ${f(percentile(times, 50))} | ` +
      `${f(percentile(times, 95))} | ` +
      `${f(percentile(times, 99))} | ${f(((cpu.user + cpu.system) / 1e6 / seconds) * 100, 0)}% |`,
  );
}

// E. Sections that try to take too much: how soon they are cut off, and what is left.
out();
out('## E. Sections that go over a limit (the rest of the page still renders)');
out();
out('| Section | Stopped by | After ms | Nodes rendered | Page ms |');
out('|---|---|---:|---:|---:|');
const abuse: Record<string, string> = {
  'Loop of 400 × 400': '{% for i in (1..400) %}{% for j in (1..400) %}x{% endfor %}{% endfor %}',
  'Endless recursion': "{% render 'again' %}",
  '10 MB of output':
    "{% assign s = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' %}" +
    '{% for i in (1..15000) %}{{ s }}{{ s }}{{ s }}{{ s }}{{ s }}{{ s }}{{ s }}{{ s }}{{ s }}{{ s }}{% endfor %}',
  'Range of 10 million': '{% for i in (1..10000000) %}{% break %}{% endfor %}',
  'Slow loop, few nodes': '{% for i in (1..45000) %}{{ i | times: 7 | modulo: 13 }}{% endfor %}',
};
for (const [name, source] of Object.entries(abuse)) {
  const bad: ThemeFiles = {
    ...files,
    'sections/bad.liquid': source,
    'snippets/again.liquid': "{% render 'again' %}",
    'templates/index.json': JSON.stringify({
      sections: { bad: { type: 'bad' }, ok: { type: 'whatsapp-cta' } },
      order: ['bad', 'ok'],
    }),
  };
  const renderer = new PageRenderer(loadTheme(bad), { onError: () => {} });
  const page = await renderer.render({ path: '/' }, new MemoryStore(documents));
  const stat = page.renders.find((render) => render.id === 'bad')!;
  out(`| ${name} | ${stat.error ?? 'nothing'} | ${f(stat.ms)} | ${stat.nodes} | ${f(page.ms)} |`);
}

const target = process.argv.includes('--write')
  ? process.argv[process.argv.indexOf('--write') + 1]
  : undefined;
if (target) await writeFile(target, `${lines.join('\n')}\n`);

/** Renders `request` again and again, one at a time, after warming up. */
async function measure(renderer: PageRenderer, request: PageRequest, latencyMs: number) {
  const store = new MemoryStore(documents, latencyMs);
  for (let run = 0; run < WARM_UP; run += 1) await renderer.render(request, store.fresh());
  const times: number[] = [];
  let last = { kb: 0, nodes: 0, roundTrips: 0 };
  const cpuBefore = process.cpuUsage();
  for (let run = 0; run < RUNS; run += 1) {
    const data = store.fresh();
    const page = await renderer.render(request, data);
    times.push(page.ms);
    last = {
      kb: page.html.length / 1024,
      nodes: page.renders.reduce((sum, render) => sum + render.nodes, 0),
      roundTrips: data.roundTrips,
    };
  }
  const cpu = process.cpuUsage(cpuBefore);
  times.sort((a, b) => a - b);
  return {
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    p99: percentile(times, 99),
    max: times.at(-1)!,
    cpu: (cpu.user + cpu.system) / 1000 / RUNS,
    ...last,
  };
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function median(values: number[]): number {
  return percentile(
    [...values].sort((a, b) => a - b),
    50,
  );
}

function f(value: number, digits = 1): string {
  return value.toFixed(digits);
}
