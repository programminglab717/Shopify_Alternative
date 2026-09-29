import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  html,
  ltr,
  renderDocument,
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
