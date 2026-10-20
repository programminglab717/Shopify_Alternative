import { Search } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';

/** A page's own title and description for search engines, as Shopify's SEO has them (ADR-231). */
export interface SeoValue {
  title: string | null;
  description: string | null;
}

/** About what search engines show of a title, and of a description (ADR-231). */
export const TITLE_SHOWN = 60;
export const DESCRIPTION_SHOWN = 160;

/** The most the fields take: Shopify's own limits on what it keeps are wider (ADR-231). */
const TITLE_MOST = 70;
const DESCRIPTION_MOST = 320;

/**
 * `text` cut at a word to about `max` characters, with "…" where it was cut, as the storefront
 * cuts a description made from a page's text; its tags gone and its spaces run together. Empty for
 * none.
 */
export function excerpt(text: string, max: number): string {
  const flat = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(flat);
  if (characters.length <= max) return flat;
  const cut = characters.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > cut.length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * How a search engine lists a page (OS-09, ADR-600): its address, its title and its description,
 * each cut about where the engine cuts it. The address is the shop's storefront's and the page's
 * path, or the path alone while the storefront's is not known.
 */
export function SearchListingPreview({
  url,
  title,
  description,
}: {
  url: string;
  title: string;
  description: string;
}) {
  const { t } = useLocale();
  const address = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return (
    <figure
      aria-label={t('searchListing.preview')}
      className="flex flex-col gap-1 rounded-control border border-line bg-canvas p-3"
    >
      <span
        dir="ltr"
        className="text-secondary break-all text-start text-[length:var(--hatti-type-body-sm-size)]"
      >
        {address.split('/').join(' › ')}
      </span>
      <span dir="auto" className="text-[1.125rem] leading-snug text-primary">
        {excerpt(title, TITLE_SHOWN)}
      </span>
      <span dir="auto" className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {description ? excerpt(description, DESCRIPTION_SHOWN) : t('searchListing.noDescription')}
      </span>
    </figure>
  );
}

/**
 * The card a product, collection or page is given its title and description for search engines
 * with (OS-09, ADR-600), and sees how they list it as they are typed: left blank, its own title,
 * and the start of its own text. `save` gives back what went wrong, or null once saved.
 */
export function SearchListingCard({
  url,
  ownTitle,
  ownText,
  stored: kept,
  save,
}: {
  url: string;
  ownTitle: string;
  ownText: string;
  stored: SeoValue;
  save: (seo: { title: string; description: string }) => Promise<string | null>;
}) {
  const { t } = useLocale();
  const id = useId();
  const [stored, setStored] = useState({
    title: kept.title ?? '',
    description: kept.description ?? '',
  });
  const [title, setTitle] = useState(stored.title);
  const [description, setDescription] = useState(stored.description);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const typed = { title: title.trim(), description: description.replace(/\s+/g, ' ').trim() };
  const changed = typed.title !== stored.title || typed.description !== stored.description;

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    setBusy(true);
    try {
      const wrong = await save(typed);
      if (wrong) setProblem(wrong);
      else {
        setStored(typed);
        setSaved(true);
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormSection title={t('searchListing.title')} hint={t('searchListing.hint')}>
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        <SearchListingPreview
          url={url}
          title={typed.title || ownTitle}
          description={typed.description || ownText}
        />
        <TextField
          label={t('searchListing.pageTitle')}
          hint={t('searchListing.pageTitleHint', {
            count: Array.from(typed.title).length,
            shown: TITLE_SHOWN,
          })}
          dir="auto"
          maxLength={TITLE_MOST}
          placeholder={ownTitle}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-description`} className="font-medium">
            {t('searchListing.description')}
          </label>
          <textarea
            id={`${id}-description`}
            aria-describedby={`${id}-description-hint`}
            value={description}
            rows={3}
            dir="auto"
            maxLength={DESCRIPTION_MOST}
            onChange={(event) => setDescription(event.target.value)}
            className="rounded-control border border-line bg-surface px-3 py-2 text-text"
          />
          <span
            id={`${id}-description-hint`}
            className="text-secondary text-[length:var(--hatti-type-body-sm-size)]"
          >
            {t('searchListing.descriptionHint', {
              count: Array.from(typed.description).length,
              shown: DESCRIPTION_SHOWN,
            })}
          </span>
        </div>
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && <Alert tone="success">{t('searchListing.saved')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={busy}
          disabled={!changed}
          icon={<Search aria-hidden className="size-5" />}
        >
          {t('searchListing.save')}
        </Button>
      </form>
    </FormSection>
  );
}
