import { Copy } from 'lucide-react';
import { useState } from 'react';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { Button } from '../ui/button';
import { FormSection } from './product-form';

/** The snippet another website pastes to show the product, as the storefront serves it. */
export function buyButtonSnippet(
  storefront: string,
  handle: string,
  language: 'en' | 'ur',
): string {
  const origin = storefront.replace(/\/+$/, '');
  const lang = language === 'ur' ? ' data-language="ur"' : '';
  return (
    `<div data-hatti-buy-button="${handle}"${lang}></div>\n` +
    `<script src="${origin}/buy-button.js" async></script>`
  );
}

/**
 * A buy button for the product (CH-08, ADR-860): the snippet to paste into a blog, a site or a
 * link page, which shows its photo, price and variants there, Buy now opening the shop's
 * checkout. For an active product, as the storefront shows no other.
 */
export function BuyButtonCard({
  product,
  storefront,
}: {
  product: { handle: string; status: string };
  storefront: string;
}) {
  const { t } = useLocale();
  const [language, setLanguage] = useState<'en' | 'ur'>('en');
  const [copied, setCopied] = useState(false);
  if (product.status !== 'ACTIVE' || !storefront) return null;
  const snippet = buyButtonSnippet(storefront, product.handle, language);
  return (
    <FormSection title={t('buyButton.title')} hint={t('buyButton.hint')}>
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
