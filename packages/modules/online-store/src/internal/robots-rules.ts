import { robotsTxt, robotsVerdict } from '@hatti/storefront-api';

/** The most a shop's robots.txt rules may be: room for many groups, not a second site. */
export const ROBOTS_RULES_LIMITS = { lines: 200, length: 10_000 } as const;

/** The directives crawlers read, by the name they are typed with, in the case they are written. */
const DIRECTIVES = new Map([
  ['user-agent', 'User-agent'],
  ['allow', 'Allow'],
  ['disallow', 'Disallow'],
  ['crawl-delay', 'Crawl-delay'],
  ['sitemap', 'Sitemap'],
]);

/** A crawler's name, as robots.txt names them: Googlebot, Googlebot-Image, *. */
const AGENT = /^[\w.*-]{1,100}$/;
/** A path pattern: from the root, or any path, with Google's `*` and `$`. */
const PATH = /^[/*][^\s#]{0,500}$/;

/**
 * Rules a shop adds to its storefront's robots.txt (ADR-055), as the storefront serves them:
 * each line a directive crawlers read, `User-agent`, `Allow`, `Disallow`, `Crawl-delay` or
 * `Sitemap`, written in their usual case, or a comment or a blank line between groups; with
 * what is wrong with the lines that are not, by their number.
 */
export function robotsRules(text: string): { rules: string; problems: string[] } {
  const problems: string[] = [];
  const rules: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') {
      // One blank line between groups is enough.
      if (rules.length > 0 && rules.at(-1) !== '') rules.push('');
      continue;
    }
    if (/\p{Cc}/u.test(line)) {
      problems.push(`Line ${index + 1} has characters crawlers cannot read`);
      continue;
    }
    if (line.startsWith('#')) {
      rules.push(line);
      continue;
    }
    const rule = ruleOf(line);
    if (rule === null) {
      problems.push(
        `Line ${index + 1} isn't a rule crawlers read: use User-agent, Allow, Disallow, ` +
          'Crawl-delay or Sitemap, then a colon and its value',
      );
    } else rules.push(rule);
  }
  while (rules.at(-1) === '') rules.pop();
  return { rules: rules.join('\n'), problems };
}

/** A directive and its value, as robots.txt writes them; null for anything else. */
function ruleOf(line: string): string | null {
  const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
  const directive = match && DIRECTIVES.get(match[1]!.toLowerCase());
  if (!directive) return null;
  // A comment after the value is the value's no longer.
  const value = match[2]!.replace(/\s+#.*$/, '').trim();
  const valid =
    directive === 'User-agent'
      ? AGENT.test(value)
      : directive === 'Allow'
        ? PATH.test(value)
        : directive === 'Disallow'
          ? value === '' || PATH.test(value)
          : directive === 'Crawl-delay'
            ? /^\d{1,2}(\.\d{1,2})?$/.test(value)
            : isWebAddress(value);
  return valid ? `${directive}: ${value}`.trimEnd() : null;
}

function isWebAddress(value: string): boolean {
  if (value.length > 2048 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** What the shop asks of a robots.txt test (ADR-616). */
export interface RobotsTestInput {
  /** The address to try: a path on the storefront, /products/lawn, or the whole address. */
  path: string;
  /** The crawler, as robots.txt names it; Googlebot if left out. */
  userAgent?: string | null;
  /** Rules to try in place of the saved ones, as they would be saved; the saved ones if left out. */
  robotsTxtRules?: string | null;
}

/** Whether a crawler may fetch an address by the storefront's robots.txt, and why. */
export interface RobotsTestResult {
  /** Null when the address is none a crawler could ask for. */
  allowed: boolean | null;
  /** The Allow or Disallow line that decided; null when none did. */
  rule: string | null;
  /** The group the crawler followed: its own name, or `*`. */
  userAgent: string;
  /** What is wrong with the address, or with the lines of the rules tried, which are left out. */
  problems: string[];
}

/**
 * Tries an address against the robots.txt the storefront would serve with `rules`, in the shop's
 * languages, as a crawler reads it (ADR-616).
 */
export function robotsTest(
  rules: string,
  input: RobotsTestInput,
  languages: { locales: readonly string[]; defaultLocale: string },
): RobotsTestResult {
  const tried =
    input.robotsTxtRules !== undefined && input.robotsTxtRules !== null
      ? robotsRules(input.robotsTxtRules)
      : null;
  const problems = [...(tried?.problems ?? [])];
  const crawler = input.userAgent?.trim() || 'Googlebot';
  const path = pathOf(input.path);
  if (path === null) {
    problems.unshift('Give an address on the shop, such as /products/lawn-suit');
    return { allowed: null, rule: null, userAgent: crawler, problems };
  }
  // The origin names the sitemap alone, which no verdict reads.
  const txt = robotsTxt('https://shop.invalid', languages, tried ? tried.rules : rules);
  const verdict = robotsVerdict(txt, crawler, path);
  return { allowed: verdict.allowed, rule: verdict.rule, userAgent: verdict.group, problems };
}

/** The path and query of an address, from a path or a whole web address; null for neither. */
function pathOf(given: string): string | null {
  const text = given.trim();
  if (text.startsWith('/')) return text.length <= 2048 && !/\s/.test(text) ? text : null;
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.pathname + url.search;
  } catch {
    return null;
  }
}
