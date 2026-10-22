import { describe, expect, it } from 'vitest';
import {
  LEGAL_DOCUMENTS,
  LEGAL_REVIEWED,
  SHOP_AGREEMENT,
  SUB_PROCESSORS,
  blanks,
  legalDocument,
  legalVersions,
} from './index.js';

const URDU = /[؀-ۿ]/;

describe("Hatti's legal documents", () => {
  it('each has its own handle, a dated version, its title and gist in Urdu, and numbered text', () => {
    expect(new Set(LEGAL_DOCUMENTS.map((document) => document.handle)).size).toBe(
      LEGAL_DOCUMENTS.length,
    );
    for (const document of LEGAL_DOCUMENTS) {
      expect(document.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${document.version}T00:00:00Z`))).toBe(false);
      expect(document.title.ur).toMatch(URDU);
      expect(document.urdu.length).toBeGreaterThan(0);
      for (const paragraph of document.urdu) expect(paragraph).toMatch(URDU);
      expect(document.sections.length).toBeGreaterThan(0);
      for (const section of document.sections) expect(section.paragraphs.length).toBeGreaterThan(0);
    }
  });

  it('finds a document by its handle, and none by another', () => {
    expect(legalDocument('terms')?.title.en).toBe('Terms of service');
    expect(legalDocument('cookies')).toBeNull();
    expect(legalVersions()).toEqual(
      Object.fromEntries(LEGAL_DOCUMENTS.map((document) => [document.handle, document.version])),
    );
  });

  it('asks a shop to agree to the terms, the acceptable use policy and the processing agreement', () => {
    expect(SHOP_AGREEMENT).toEqual(['terms', 'acceptable-use', 'data-processing']);
    for (const handle of SHOP_AGREEMENT) expect(legalDocument(handle)).not.toBeNull();
  });

  it('names each sub-processor with what it does, what data it gets and where', () => {
    expect(SUB_PROCESSORS.length).toBeGreaterThan(0);
    for (const each of SUB_PROCESSORS) {
      expect(each.name && each.purpose && each.data && each.location).toBeTruthy();
      // One still to choose is a blank, so the list can't be taken as final with it in.
      if (each.status === 'to_choose') expect(each.name).toMatch(/^\[To come: /);
    }
    expect(blanks(legalDocument('sub-processors')!)).toContain(
      '[To come: the SMS gateway (OWN-10)]',
    );
  });

  it('is not marked reviewed while a blank is left for counsel or the owner', () => {
    const left = LEGAL_DOCUMENTS.flatMap(blanks);
    expect(left.length).toBeGreaterThan(0);
    if (left.length > 0) expect(LEGAL_REVIEWED).toBe(false);
  });

  it('says what the platform does as built: no fee on sales, the grace week, the cash cap', () => {
    const terms = legalDocument('terms')!
      .sections.flatMap((section) => section.paragraphs)
      .join(' ');
    expect(terms).toContain('Hatti charges no fee on your sales');
    expect(terms).toContain('seven days after it ends');
    expect(terms).toContain('Rs 200,000');
  });
});
