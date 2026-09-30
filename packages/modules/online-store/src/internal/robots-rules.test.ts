import { describe, expect, it } from 'vitest';
import { robotsRules } from './robots-rules.js';

describe("A shop's robots.txt rules", () => {
  it('keeps the directives crawlers read, in their usual case, and comments between groups', () => {
    const { rules, problems } = robotsRules(
      [
        '# Keep crawlers off the sale while it is set up',
        'disallow:/collections/sale',
        'ALLOW: /collections/sale/lawn   # but not the lawn',
        '',
        '',
        'User-agent: Googlebot-Image',
        'Disallow:',
        'crawl-delay: 2.5',
        'Sitemap: https://zari.pk/extra-sitemap.xml',
        '',
      ].join('\r\n'),
    );
    expect(problems).toEqual([]);
    expect(rules).toBe(
      [
        '# Keep crawlers off the sale while it is set up',
        'Disallow: /collections/sale',
        'Allow: /collections/sale/lawn',
        '',
        'User-agent: Googlebot-Image',
        'Disallow:',
        'Crawl-delay: 2.5',
        'Sitemap: https://zari.pk/extra-sitemap.xml',
      ].join('\n'),
    );
    expect(robotsRules(' \n\n ').rules).toBe('');
  });

  it('says which lines crawlers would not read', () => {
    const tab = String.fromCharCode(9);
    const { problems } = robotsRules(
      [
        'Disallow /cart',
        'Noindex: /pages/secret',
        'User-agent: bad agent',
        'Allow: pages',
        'Crawl-delay: soon',
        'Sitemap: /sitemap.xml',
        `Disallow: /a${tab}b`,
        `# a comment${String.fromCharCode(0)}`,
      ].join('\n'),
    );
    expect(problems.map((problem) => problem.split(' ')[1])).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
    ]);
  });
});
