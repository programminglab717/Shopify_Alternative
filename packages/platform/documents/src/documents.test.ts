import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  html,
  ltr,
  renderDocument,
  renderPage,
  say,
  text,
  toMarkup,
  type HtmlValue,
} from './index.js';

describe('html', () => {
  it('escapes every value that is not markup already', () => {
    const name = `Ayesha "<script>alert('x')</script>" & co`;
    expect(toMarkup(html`<td title="${name}">${name}</td>`)).toBe(
      '<td title="Ayesha &quot;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&quot; &amp; co">' +
        'Ayesha &quot;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&quot; &amp; co</td>',
    );
    expect(escapeHtml(`<a href='x'>`)).toBe('&lt;a href=&#39;x&#39;&gt;');
  });

  it('keeps markup, joins lists and leaves nothing for null, undefined and false', () => {
    const cells: HtmlValue[] = ['a<b', html`<b>bold</b>`, 3, 42n, null, undefined, false];
    const row = cells.map((cell) => html`<td>${cell}</td>`);
    expect(toMarkup(row)).toBe(
      '<td>a&lt;b</td><td><b>bold</b></td><td>3</td><td>42</td><td></td><td></td><td></td>',
    );
    expect(toMarkup(html`${[['nested', html`<i>list</i>`]]}`)).toBe('nested<i>list</i>');
    // Something shaped like markup but not made by html`` is still text.
    const forged = JSON.parse('{"markup": "<script>"}') as unknown as HtmlValue;
    expect(toMarkup(html`${forged}`)).toBe('[object Object]');
  });
});

describe('wording', () => {
  const words = { en: 'Thank you!', ur: 'شکریہ!' };

  it('says things in English, Urdu, or both', () => {
    expect(toMarkup(say('english', words))).toBe('Thank you!');
    expect(toMarkup(say('urdu', words))).toBe('<span lang="ur">شکریہ!</span>');
    expect(toMarkup(say('bilingual', words))).toBe(
      '<span class="both"><span lang="en">Thank you!</span> ' +
        '<span lang="ur" dir="rtl">شکریہ!</span></span>',
    );
  });

  it('isolates typed text and left-to-right values', () => {
    expect(toMarkup(text('House 12 <b>'))).toBe('<bdi>House 12 &lt;b&gt;</bdi>');
    expect(toMarkup(text(null))).toBe('');
    expect(toMarkup(ltr('#1001'))).toBe('<bdi dir="ltr">#1001</bdi>');
  });
});

describe('renderDocument', () => {
  const pages = [html`<h1>One</h1>`, html`<h1>Two</h1>`];
  /** The attributes of the root element, however the markup is laid out. */
  const root = (document: string) =>
    /<html\s+lang="(\w+)"\s+dir="(\w+)"\s+data-paper="(\w+)"\s*>/.exec(document)?.slice(1);

  it('puts each page on its own sheet, set up for the paper', () => {
    const document = renderDocument({
      title: 'Packing slips <2>',
      paper: 'a4',
      language: 'bilingual',
      pages,
    });
    expect(document.startsWith('<!doctype html>')).toBe(true);
    expect(root(document)).toEqual(['en', 'ltr', 'a4']);
    expect(document).toContain('<title>Packing slips &lt;2&gt;</title>');
    expect(document.match(/<article class="page">/g)).toHaveLength(2);
    expect(document).toContain('<article class="page"><h1>Two</h1></article>');
    expect(document).toContain('@page { size: A4; margin: 14mm 12mm; }');
    expect(document).toContain('family=Inter:wght@400;600;700&amp;family=Noto+Nastaliq+Urdu');
    expect(document).not.toContain('<script');
  });

  it('runs right to left in Urdu, and fits thermal paper', () => {
    const urdu = renderDocument({ title: 'x', paper: 'thermal_4x6', language: 'urdu', pages });
    expect(root(urdu)).toEqual(['ur', 'rtl', 'thermal_4x6']);
    expect(urdu).toContain('@page { size: 4in 6in; margin: 4mm; }');
    expect(urdu).toContain('.columns { grid-template-columns: 1fr; gap: 0.6em; }');
    const roll = renderDocument({ title: 'x', paper: 'thermal_80mm', language: 'english', pages });
    expect(roll).toContain('.page { width: 72mm; margin-inline: auto; padding: 3mm 0; }');
    expect(roll).not.toContain('size: A4');
  });
});

describe('renderPage', () => {
  it("is a page for a customer's phone, allowed its own styles and nothing more", () => {
    const page = renderPage({
      title: 'Confirm your order · Zari <Fashions>',
      body: html`<p>${'<b>Ayesha</b>'}</p>`,
    });
    expect(page.html.startsWith('<!doctype html>')).toBe(true);
    expect(page.html).toContain('<title>Confirm your order · Zari &lt;Fashions&gt;</title>');
    expect(page.html).toContain('<main><p>&lt;b&gt;Ayesha&lt;/b&gt;</p></main>');
    expect(page.html).toContain('<meta name="referrer" content="no-referrer" />');
    expect(page.html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(page.html).not.toContain('<script');
    // The policy's hash is of the page's one style element, exactly.
    const styles = page.html.match(/<style>([\s\S]*?)<\/style>/g) ?? [];
    expect(styles).toHaveLength(1);
    const hash = createHash('sha256')
      .update(styles[0]!.slice('<style>'.length, -'</style>'.length))
      .digest('base64');
    expect(page.contentSecurityPolicy).toBe(
      `default-src 'none'; style-src 'sha256-${hash}' https://fonts.googleapis.com; ` +
        "font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; " +
        "frame-ancestors 'none'",
    );
  });

  it("takes the shop's colour where it reads, its own style allowed by its hash", () => {
    const stylesOf = (accent: string | null) => {
      const page = renderPage({ title: 'Checkout · Zari', body: html`<p>Hi</p>`, accent });
      const styles = [...page.html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
        (match) => match[1]!,
      );
      const hashes = styles.map(
        (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`,
      );
      expect(page.contentSecurityPolicy).toContain(`style-src ${hashes.join(' ')} https:`);
      return styles.slice(1);
    };
    // Amber reads on white: its buttons take white text, and its links are amber.
    expect(stylesOf('#b45309')).toEqual([
      ':root { --accent: #B45309; --on-accent: #FFFFFF; --link: #B45309; }',
    ]);
    // A light yellow: dark text on its buttons, and links in the platform's colour.
    expect(stylesOf('#FBBF24')).toEqual([
      ':root { --accent: #FBBF24; --on-accent: #0F172A; --link: #0F766E; }',
    ]);
    // A mid grey, on which neither reads at 4.5 to 1: black, which does.
    expect(stylesOf('#7F7F7F')).toEqual([
      ':root { --accent: #7F7F7F; --on-accent: #000000; --link: #0F766E; }',
    ]);
    expect(stylesOf('#abc')[0]).toContain('--accent: #AABBCC;');
    // Anything but a colour never reaches the page.
    for (const accent of [null, '', 'red', '#B45309; } body { display: none', 'url(x)']) {
      expect(stylesOf(accent), String(accent)).toEqual([]);
    }
  });

  it('shows the images it is given, each allowed at its own address, and no others', () => {
    const logo = 'https://acct.r2.cloudflarestorage.com/files/shops/1/files/2/logo.png';
    const local = 'http://localhost:4000/storage/shops/1/files/3/logo.webp';
    const page = renderPage({
      title: 'Checkout · Zari',
      body: html`<img class="logo" src="${logo}?X-Amz-Signature=abc" alt="Zari" />`,
      images: [
        `${logo}?X-Amz-Signature=abc&X-Amz-Expires=3600`,
        `${local}?expires=1&signature=x`,
        // Not over https, nor in development; something more than an address; not one at all.
        'http://example.com/logo.png',
        "https://example.com/a.png;script-src 'unsafe-inline'",
        'javascript:alert(1)',
        'logo.png',
      ],
    });
    expect(page.contentSecurityPolicy).toContain(`; img-src ${logo} ${local}; form-action 'self';`);
    expect(page.html).toContain(`src="${logo}?X-Amz-Signature=abc"`);
    // Without images, none are allowed.
    for (const images of [undefined, [], ['ftp://example.com/a.png']]) {
      const plain = renderPage({ title: 'Zari', body: html`<p>Hi</p>`, images });
      expect(plain.contentSecurityPolicy).not.toContain('img-src');
    }
  });
});
