import { describe, expect, it } from 'vitest';
import { cleanPageBody } from './page-body.js';

describe('cleanPageBody', () => {
  it('keeps text, its formatting, links, images and tables', () => {
    const body =
      '<h2 style="text-align:center">About us</h2>' +
      '<p dir="rtl" lang="ur">آپ کا شکریہ &amp; <strong>Lahore</strong> <em>since 1998</em></p>' +
      '<ul><li>Delivery in <a href="/pages/delivery">2 to 5 days</a></li>' +
      '<li><a href="https://wa.me/923001234567">WhatsApp</a>, <a href="tel:+923001234567">call</a>' +
      ' or <a href="mailto:hi@zari.pk">email</a></li></ul>' +
      '<img src="https://cdn.hatti.pk/zari/shop.jpg" alt="Our shop" width="600">' +
      '<table><tr><th scope="col">City</th><td colspan="2">Karachi</td></tr></table>';
    expect(cleanPageBody(body)).toBe(body.replace('width="600">', 'width="600" />'));
  });

  it('takes out whatever could run, frame, post or restyle the page', () => {
    expect(cleanPageBody('<p onclick="steal()">Hi <script>steal()</script>there</p>')).toBe(
      '<p>Hi there</p>',
    );
    expect(
      cleanPageBody(
        '<a href="javascript:alert(1)">a</a><a href="jav&#x61;script:alert(1)">b</a>' +
          '<a href="//evil.example">c</a><a href="data:text/html,x">d</a>',
      ),
    ).toBe('<a>a</a><a>b</a><a>c</a><a>d</a>');
    // An image only from the web or the shop's own address, with nothing to run when it fails.
    expect(
      cleanPageBody(
        '<img src="data:image/png;base64,AAAA"><img src="/images/x.jpg" onerror="y()">',
      ),
    ).toBe('<img src="/images/x.jpg" />');
    expect(
      cleanPageBody(
        '<iframe src="https://example.com"></iframe><form action="/x"><input name="q"></form>' +
          '<style>body{display:none}</style><!-- a note --><svg><script>x()</script></svg>',
      ),
    ).toBe('');
    // Only where text sits and its colours, and no names the theme's scripts look for.
    expect(
      cleanPageBody(
        '<p id="cart" class="x" style="position:fixed;top:0;color:#b91c1c;text-align:right">!</p>',
      ),
    ).toBe('<p style="color:#b91c1c;text-align:right">!</p>');
  });

  it('keeps a new tab from reaching back to the shop', () => {
    expect(cleanPageBody('<a href="https://instagram.com/zari" target="_blank">Insta</a>')).toBe(
      '<a href="https://instagram.com/zari" target="_blank" rel="noopener noreferrer">Insta</a>',
    );
  });

  it('changes nothing it already cleaned', () => {
    const once = cleanPageBody(
      '<p style="text-align:center">Eid <b>sale</b> &lt;3</p><script>x()</script><a href="/cart">x</a>',
    );
    expect(cleanPageBody(once)).toBe(once);
  });
});
