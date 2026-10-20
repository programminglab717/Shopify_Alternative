// What a shop's robots.txt lets crawlers fetch (OS-09): the file the storefront serves (ADR-055),
// and which of its rules a crawler follows for an address, as RFC 9309 and Google read them
// (ADR-616), so that the admin can test a shop's rules before crawlers meet them.

/**
 * robots.txt: crawlers may fetch pages, in every language, but not carts, checkouts, searches,
 * the editor's routes, previews, other sort orders of a listing, or sections alone; and the
 * sitemap is at the shop's address. The shop's own rules (ADR-055) follow the platform's: those
 * before any `User-agent` of its own are for every crawler, beside the platform's; its groups
 * come after, and its sitemaps with the platform's.
 */
export function robotsTxt(
  origin: string,
  languages: { locales: readonly string[]; defaultLocale: string },
  rules = '',
): string {
  const prefixes = [
    '',
    ...languages.locales.filter((code) => code !== languages.defaultLocale).map((c) => `/${c}`),
  ];
  const lines = rules === '' ? [] : rules.split('\n');
  const sitemaps = lines.filter((line) => line.startsWith('Sitemap:'));
  const others = lines.filter((line) => !line.startsWith('Sitemap:'));
  const groupsAt = others.findIndex((line) => line.startsWith('User-agent:'));
  const forAll = groupsAt === -1 ? others : others.slice(0, groupsAt);
  const groups = groupsAt === -1 ? [] : others.slice(groupsAt);
  return [
    [
      'User-agent: *',
      ...prefixes.flatMap((prefix) =>
        ['/cart', '/checkout', '/search'].map((path) => `Disallow: ${prefix}${path}`),
      ),
      'Disallow: /checkouts/',
      'Disallow: /editor/',
      'Disallow: /*?*preview=',
      'Disallow: /*?*sort_by=',
      'Disallow: /*?*section_id=',
      'Disallow: /*?*sections=',
      // A blank line would end the group: the shop's rules for every crawler join it.
      ...forAll.filter((line) => line !== ''),
    ].join('\n'),
    groups.join('\n').trim(),
    [`Sitemap: ${origin}/sitemap.xml`, ...sitemaps].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}

/** What a crawler may do with an address, by robots.txt, and the rule that says so. */
export interface RobotsVerdict {
  allowed: boolean;
  /** The `Allow` or `Disallow` line that decided, as written; null when none matched. */
  rule: string | null;
  /** The `User-agent` the crawler followed: its own name as written, or `*`. */
  group: string;
}

interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; pattern: string; line: string }[];
}

/**
 * Whether `crawler`, a product token such as Googlebot, may fetch `path` by `txt`, as RFC 9309
 * reads it: the group naming the crawler (the longest name it starts with, ignoring case), every
 * group of that name together, else `*`'s; of its rules, the longest pattern that matches the
 * path, `*` matching anything and `$` its end, an `Allow` winning a tie; allowed when none does.
 * /robots.txt itself is always allowed.
 */
export function robotsVerdict(txt: string, crawler: string, path: string): RobotsVerdict {
  const groups = robotsGroups(txt);
  const name = crawler.trim().toLowerCase();
  let best = '';
  for (const group of groups) {
    for (const agent of group.agents) {
      const token = agent.toLowerCase();
      if (token !== '*' && name.startsWith(token) && token.length > best.length) best = token;
    }
  }
  const wanted = best === '' ? '*' : best;
  const chosen = groups.filter((group) =>
    group.agents.some((agent) => agent.toLowerCase() === wanted),
  );
  const group =
    wanted === '*'
      ? '*'
      : chosen.flatMap((each) => each.agents).find((agent) => agent.toLowerCase() === wanted)!;
  if (path === '/robots.txt') return { allowed: true, rule: null, group };
  let decided: { allow: boolean; pattern: string; line: string } | null = null;
  for (const rule of chosen.flatMap((each) => each.rules)) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (
      !decided ||
      rule.pattern.length > decided.pattern.length ||
      (rule.pattern.length === decided.pattern.length && rule.allow && !decided.allow)
    ) {
      decided = rule;
    }
  }
  return { allowed: decided ? decided.allow : true, rule: decided?.line ?? null, group };
}

/** robots.txt's groups: User-agent lines in a row, then the rules that follow them. */
function robotsGroups(txt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const directive = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (directive === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value);
      lastWasAgent = true;
    } else if ((directive === 'allow' || directive === 'disallow') && current) {
      lastWasAgent = false;
      // An empty Disallow allows everything: no rule at all.
      if (value !== '') {
        current.rules.push({ allow: directive === 'allow', pattern: value, line: line });
      }
    } else if (directive !== 'sitemap') {
      lastWasAgent = false;
    }
  }
  return groups;
}

/** Whether a path pattern, with `*` for anything and a final `$` for the end, matches `path`. */
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}
