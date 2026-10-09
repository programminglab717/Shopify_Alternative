import { beforeAll, describe, expect, it } from 'vitest';
import { editorSchemas, loadTheme, platformTheme, type Theme } from './index.js';

describe("The theme editor's schemas", () => {
  let base: Theme;

  beforeAll(async () => {
    base = await platformTheme('hatti-base');
  });

  const section = (locale: string, type: string) =>
    editorSchemas(base, locale).sections.find((each) => each.type === type)!.schema;

  it("gives Hatti Base's settings and sections in English, and in Urdu", () => {
    const english = editorSchemas(base, 'en');
    expect(english.settingsSchema.map((group) => (group as { name: string }).name)).toEqual([
      'theme_info',
      'Colours',
      'Layout',
      'Orders',
    ]);
    expect(english.sections.map((each) => each.type)).toContain('image-banner');
    expect(section('en', 'image-banner')).toMatchObject({
      name: 'Image banner',
      settings: [{ type: 'image_picker', id: 'image', label: 'Image' }],
      blocks: [
        { type: 'heading', name: 'Heading', limit: 1 },
        { type: 'text', name: 'Text' },
        { type: 'button', name: 'Button', limit: 2 },
      ],
    });
    expect(section('ur', 'image-banner')).toMatchObject({
      name: 'تصویری بینر',
      blocks: [{ name: 'سرخی' }, { name: 'متن' }, { name: 'بٹن' }],
    });
    // A select's choices, and the defaults the storefront prints, as they are.
    const orders = editorSchemas(base, 'ur').settingsSchema[3] as {
      settings: { options?: { label: string }[]; default: unknown }[];
    };
    expect(orders.settings[0]!.options!.map((option) => option.label)).toEqual([
      'کارٹ کو صفحے کے اوپر سائیڈ پینل میں دکھائیں',
      'کارٹ کے صفحے پر جائیں',
    ]);
    expect(orders.settings[0]!.default).toBe('drawer');
    expect(section('ur', 'whatsapp-cta').settings![0]).toMatchObject({
      label: 'سرخی',
      default: 'Questions? Ask us on WhatsApp',
    });
  });

  it('has the words for every key in both languages, and English for a language it lacks', () => {
    for (const locale of ['en', 'ur', 'pa', '../ur', '']) {
      const json = JSON.stringify(editorSchemas(base, locale));
      expect(json, locale).not.toContain('"t:');
    }
    expect(section('pa', 'header').name).toBe('Header');
  });

  it("takes the default language's words where a language lacks one, and words as written", () => {
    const theme = loadTheme({
      'sections/hero.liquid':
        '{% schema %}' +
        JSON.stringify({
          name: 't:sections.hero.name',
          settings: [
            { type: 'text', id: 'title', label: 't:sections.hero.title', default: 't:kept' },
            { type: 'text', id: 'note', label: 'Note', info: 't:sections.hero.missing' },
          ],
        }) +
        '{% endschema %}',
      'locales/ur.default.schema.json': JSON.stringify({
        sections: { hero: { name: 'ہیرو', title: 'عنوان' } },
      }),
      'locales/en.schema.json': JSON.stringify({ sections: { hero: { name: 'Hero' } } }),
    });
    expect(editorSchemas(theme, 'en').sections).toEqual([
      {
        type: 'hero',
        schema: {
          name: 'Hero',
          settings: [
            { type: 'text', id: 'title', label: 'عنوان', default: 't:kept' },
            { type: 'text', id: 'note', label: 'Note', info: 't:sections.hero.missing' },
          ],
        },
      },
    ]);
    expect(editorSchemas(theme, 'en').settingsSchema).toEqual([]);
  });
});
