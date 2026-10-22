import { legalDocument, LEGAL_DOCUMENTS, SUB_PROCESSORS } from '@hatti/legal';
import { describe, expect, it } from 'vitest';
import { legalIndexPage, legalJson, legalPage } from './legal-page.js';

describe("Hatti's legal pages (ADR-736)", () => {
  it('lists every document with its version, a draft until counsel has reviewed them', () => {
    const page = legalIndexPage().html;
    for (const document of LEGAL_DOCUMENTS) {
      expect(page).toContain(`href="/legal/${document.handle}"`);
      expect(page).toContain(document.title.ur);
    }
    expect(page).toContain('A draft, still to be reviewed by counsel');
    expect(page).toContain('22 October 2026');
    // Its words are escaped as any other, apostrophes and all.
    expect(page).toContain('Hatti&#39;s legal documents');
    expect(page).not.toContain('There&#39;s no such document');
    expect(legalIndexPage(true).html).toContain('There&#39;s no such document');
  });

  it('shows a document, its gist in Urdu above the English text that binds', () => {
    const terms = legalDocument('terms')!;
    const page = legalPage(terms).html;
    expect(page).toContain('<title>Terms of service · Hatti</title>');
    expect(page).toContain(terms.urdu[0]);
    expect(page).toContain('نیچے دیا گیا انگریزی متن ہی قابلِ عمل ہے۔');
    expect(page.indexOf(terms.urdu[0]!)).toBeLessThan(
      page.indexOf('1. Who we are, and these terms'),
    );
    expect(page).toContain('Hatti charges no fee on your sales on any plan.');
    expect(page).not.toContain('class="section" data-status');
  });

  it('lists the sub-processors on theirs, saying which are still to be chosen', () => {
    const page = legalPage(legalDocument('sub-processors')!).html;
    for (const each of SUB_PROCESSORS) expect(page).toContain(`data-status="${each.status}"`);
    expect(page).toContain('Cloudflare, Inc.');
    expect(page).toContain('Still to be chosen');
  });

  it('gives each version and address as JSON', () => {
    expect(legalJson()).toEqual({
      reviewed: false,
      documents: LEGAL_DOCUMENTS.map((document) => ({
        handle: document.handle,
        title: document.title.en,
        titleUr: document.title.ur,
        version: document.version,
        path: `/legal/${document.handle}`,
      })),
    });
  });
});
