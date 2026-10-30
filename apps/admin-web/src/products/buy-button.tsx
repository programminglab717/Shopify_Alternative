import { Copy } from 'lucide-react';
import { useState } from 'react';
import { useLocale } from '../i18n/locale';
import { CheckField, SelectField } from '../settings/settings-form';
import { Button } from '../ui/button';
import { TextField } from '../ui/field';
import { FormSection } from './product-form';

/** The colour the buttons take until the shop picks its own: the platform's teal. */
const DEFAULT_COLOR = '#0f766e';

/**
 * How the storefront's script lays an embed out (ADR-949), the first of each its default, said in
 * the snippet only where another is chosen.
 */
export const BUY_BUTTON_LAYOUTS = {
  product: ['card', 'horizontal'],
  collection: ['grid', 'list', 'carousel'],
} as const;

/**
 * The snippet another website pastes to show the product, or with `collection` the collection
 * (ADR-925), as the storefront serves it; its buttons in `color` where given, laid out as
 * `layout` says (ADR-949); a collection's led by its product `featured` (ADR-980).
 */
export function buyButtonSnippet(
  storefront: string,
  handle: string,
  language: 'en' | 'ur',
  options: {
    collection?: boolean;
    color?: string | null;
    layout?: string | null;
    featured?: string | null;
  } = {},
): string {
  const origin = storefront.replace(/\/+$/, '');
  const lang = language === 'ur' ? ' data-language="ur"' : '';
  const color =
    options.color && /^#[0-9a-f]{6}$/i.test(options.color) ? ` data-color="${options.color}"` : '';
  const kind = options.collection ? 'data-hatti-buy-collection' : 'data-hatti-buy-button';
  const layouts: readonly string[] =
    BUY_BUTTON_LAYOUTS[options.collection ? 'collection' : 'product'];
  const layout =
    options.layout && layouts.indexOf(options.layout) > 0 ? ` data-layout="${options.layout}"` : '';
  const lead = options.featured?.replace(/[^a-z0-9-]/g, '');
  const featured = options.collection && lead ? ` data-featured="${lead}"` : '';
  return (
    `<div ${kind}="${handle}"${lang}${color}${layout}${featured}></div>\n` +
    `<script src="${origin}/buy-button.js" async></script>`
  );
}

/**
 * A buy button for the product (CH-08, ADR-860), or for a collection, a grid of its products'
 * (ADR-925): the snippet to paste into a blog, a site or a link page, which shows its photos,
 * prices and variants there, Buy now opening the shop's checkout, in the shop's colour if it
 * picks one. For an active product, as the storefront shows no other. A collection's may lead
 * with one of its `products`, across above the rest (ADR-980).
 */
export function BuyButtonCard({
  handle,
  storefront,
  collection = false,
  active = true,
  products = [],
}: {
  handle: string;
  storefront: string;
  collection?: boolean;
  active?: boolean;
  /** A collection's active products, one of which its embed may feature. */
  products?: { handle: string; title: string }[];
}) {
  const { t } = useLocale();
  const [language, setLanguage] = useState<'en' | 'ur'>('en');
  const [color, setColor] = useState<string | null>(null);
  const [layout, setLayout] = useState<string>(collection ? 'grid' : 'card');
  const [featured, setFeatured] = useState('');
  const [copied, setCopied] = useState(false);
  if (!active || !storefront) return null;
  const snippet = buyButtonSnippet(storefront, handle, language, {
    collection,
    color,
    layout,
    featured,
  });
  return (
    <FormSection
      title={t(collection ? 'buyButton.collectionTitle' : 'buyButton.title')}
      hint={t(collection ? 'buyButton.collectionHint' : 'buyButton.hint')}
    >
      <SelectField
        label={t('buyButton.language')}
        value={language}
        options={[
          { value: 'en', label: t('experts.english') },
          { value: 'ur', label: t('experts.urdu') },
        ]}
        onChange={(value) => {
          setLanguage(value);
          setCopied(false);
        }}
      />
      <SelectField
        label={t('buyButton.layout')}
        value={layout}
        options={BUY_BUTTON_LAYOUTS[collection ? 'collection' : 'product'].map((value) => ({
          value,
          label: t(`buyButton.layout.${value}`),
        }))}
        onChange={(value) => {
          setLayout(value);
          setCopied(false);
        }}
      />
      {collection && products.length > 0 && (
        <SelectField
          label={t('buyButton.featured')}
          value={featured}
          options={[
            { value: '', label: t('buyButton.featuredNone') },
            ...products.map((product) => ({ value: product.handle, label: product.title })),
          ]}
          onChange={(value) => {
            setFeatured(value);
            setCopied(false);
          }}
        />
      )}
      <CheckField
        label={t('buyButton.ownColor')}
        checked={color !== null}
        onChange={(on) => {
          setColor(on ? DEFAULT_COLOR : null);
          setCopied(false);
        }}
      />
      {color !== null && (
        <TextField
          label={t('buyButton.color')}
          type="color"
          value={color}
          onChange={(event) => {
            setColor(event.target.value);
            setCopied(false);
          }}
        />
      )}
      <pre
        className="num overflow-x-auto whitespace-pre-wrap break-all rounded-control bg-canvas p-2 text-[length:var(--hatti-type-body-sm-size)]"
        dir="ltr"
      >
        {snippet}
      </pre>
      <Button
        variant="secondary"
        className="self-start"
        icon={<Copy aria-hidden className="size-5" />}
        onClick={() => void navigator.clipboard?.writeText(snippet).then(() => setCopied(true))}
      >
        {copied ? t('staff.copied') : t('buyButton.copy')}
      </Button>
    </FormSection>
  );
}
