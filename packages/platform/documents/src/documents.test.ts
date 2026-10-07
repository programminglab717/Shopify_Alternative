import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CODE128_PATTERNS,
  code128,
  code128Symbols,
  code128Widths,
  escapeHtml,
  html,
  isCode128,
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

  it("lets its forms go on only to the origins it is given, as a gateway's checkout", () => {
    const page = renderPage({
      title: 'Your order · Zari',
      body: html`<form method="post"><button>Pay online</button></form>`,
      formTargets: [
        'https://getsafepay.com/checkout/pay?beacon=track_1',
        'https://getsafepay.com',
        'http://127.0.0.1:4010/checkout',
        // Not over https, nor on this machine; something more than an address; not one at all.
        'http://example.com',
        "https://example.com;script-src 'unsafe-inline'",
        'javascript:alert(1)',
      ],
    });
    expect(page.contentSecurityPolicy).toContain(
      "; form-action 'self' https://getsafepay.com http://127.0.0.1:4010; ",
    );
    expect(renderPage({ title: 'Zari', body: html`<p>Hi</p>` }).contentSecurityPolicy).toContain(
      "; form-action 'self'; ",
    );
  });

  it('runs the scripts it is given where its body ends, each allowed by its hash alone', () => {
    const script = "document.querySelector('[data-add]').hidden = false;";
    const page = renderPage({
      title: 'Checkout · Zari',
      body: html`<button type="button" data-add hidden>Add</button>`,
      scripts: [script],
    });
    const [, after] = page.html.split('</main>');
    expect(after!.replace(/\s+/g, '')).toBe(
      `<script>${script}</script></body></html>`.replace(/\s+/g, ''),
    );
    const hash = createHash('sha256').update(script).digest('base64');
    expect(
      page.contentSecurityPolicy.startsWith(
        `default-src 'none'; script-src 'sha256-${hash}'; style-src 'sha256-`,
      ),
    ).toBe(true);
    // What a script shows stays hidden until it runs, whatever else styles it.
    expect(page.html).toContain('[hidden] { display: none !important; }');
    // Without scripts, none may run.
    expect(
      renderPage({ title: 'Zari', body: html`<p>Hi</p>` }).contentSecurityPolicy,
    ).not.toContain('script-src');
    expect(() =>
      renderPage({ title: 'Zari', body: html``, scripts: ['a = "</script><script>alert(1)";'] }),
    ).toThrow('</script');
  });
});

describe('code128', () => {
  // The symbols as bits, 1 a bar's module and 0 a space's, tabled apart from the widths it draws
  // with, as a check on both.
  const BITS = `
    11011001100 11001101100 11001100110 10010011000 10010001100 10001001100 10011001000
    10011000100 10001100100 11001001000 11001000100 11000100100 10110011100 10011011100
    10011001110 10111001100 10011101100 10011100110 11001110010 11001011100 11001001110
    11011100100 11001110100 11101101110 11101001100 11100101100 11100100110 11101100100
    11100110100 11100110010 11011011000 11011000110 11000110110 10100011000 10001011000
    10001000110 10110001000 10001101000 10001100010 11010001000 11000101000 11000100010
    10110111000 10110001110 10001101110 10111011000 10111000110 10001110110 11101110110
    11010001110 11000101110 11011101000 11011100010 11011101110 11101011000 11101000110
    11100010110 11101101000 11101100010 11100011010 11101111010 11001000010 11110001010
    10100110000 10100001100 10010110000 10010000110 10000101100 10000100110 10110010000
    10110000100 10011010000 10011000010 10000110100 10000110010 11000010010 11001010000
    11110111010 11000010100 10001111010 10100111100 10010111100 10010011110 10111100100
    10011110100 10011110010 11110100100 11110010100 11110010010 11011011110 11011110110
    11110110110 10101111000 10100011110 10001011110 10111101000 10111100010 11110101000
    11110100010 10111011110 10111101110 11101011110 11110101110 11010000100 11010010000
    11010011100 1100011101011`
    .trim()
    .split(/\s+/);

  const bitsOf = (widths: string) =>
    [...widths].map((width, index) => (index % 2 === 0 ? '1' : '0').repeat(Number(width))).join('');

  /** The text a barcode's widths draw, read back as a scanner would, its check symbol checked. */
  function scan(widths: readonly number[]): string {
    const values: number[] = [];
    // Six widths a symbol, then Stop's seven.
    for (let at = 0; at < widths.length - 7; at += 6) {
      values.push(CODE128_PATTERNS.indexOf(widths.slice(at, at + 6).join('')));
    }
    expect(widths.slice(-7).join('')).toBe(CODE128_PATTERNS[106]);
    const [start, ...rest] = values;
    const check = rest.pop()!;
    expect(start).toBe(104);
    expect(rest.every((value) => value >= 0 && value < 95)).toBe(true);
    expect(check).toBe(rest.reduce((sum, value, index) => sum + value * (index + 1), 104) % 103);
    return rest.map((value) => String.fromCharCode(value + 32)).join('');
  }

  it('tables its 107 symbols as the bits that draw them', () => {
    expect(BITS).toHaveLength(107);
    expect(CODE128_PATTERNS.map(bitsOf)).toEqual(BITS);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.forEach((pattern, value) => {
      expect([...pattern].reduce((sum, width) => sum + Number(width), 0)).toBe(
        value === 106 ? 13 : 11,
      );
    });
  });

  it("draws a courier's tracking number, its check symbol worked out as ISO/IEC 15417 says", () => {
    // Start B; C, X, -, 1 to 7; the check symbol, (104 + 35×1 + 56×2 + … + 23×10) mod 103; Stop.
    expect(code128Symbols('CX-1234567')).toEqual([
      104, 35, 56, 13, 17, 18, 19, 20, 21, 22, 23, 62, 106,
    ]);
    const widths = code128Widths('CX-1234567');
    // Eleven modules a symbol, thirteen for Stop.
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(11 * 12 + 13);
    expect(scan(widths)).toBe('CX-1234567');
    expect(scan(code128Widths('LE 7001 ~ a'))).toBe('LE 7001 ~ a');
    // Start B is 11010010000; Stop is 1100011101011.
    expect(widths.slice(0, 6)).toEqual([2, 1, 1, 2, 1, 4]);
    expect(widths.slice(-7)).toEqual([2, 3, 3, 1, 1, 1, 2]);
  });

  it('draws an SVG of its bars, with quiet zones, named by its text', () => {
    const svg = toMarkup(code128('CX-1"<2'));
    expect(svg).toMatch(/^<svg class="barcode" viewBox="0 0 \d+ 1"/);
    expect(svg).toContain('aria-label="CX-1&quot;&lt;2"');
    expect(svg).toContain('<rect x="10" width="2" height="1"/>');
    const modules = code128Widths('CX-1"<2').reduce((sum, width) => sum + width, 0);
    expect(svg).toContain(`viewBox="0 0 ${modules + 20} 1"`);
    // Three bars a symbol, Start, seven characters and the check; four for Stop.
    expect((svg.match(/<rect /g) ?? []).length).toBe(3 * 9 + 4);
  });

  it('takes printable ASCII alone, 1 to 80 characters', () => {
    expect(isCode128('CX-1234567')).toBe(true);
    expect(isCode128('')).toBe(false);
    expect(isCode128('x'.repeat(81))).toBe(false);
    expect(isCode128('لاہور')).toBe(false);
    expect(() => code128('CX\n1')).toThrow('Code 128 draws printable ASCII');
  });
});
