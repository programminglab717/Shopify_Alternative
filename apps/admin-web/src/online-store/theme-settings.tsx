import { ImageOff, ImageUp, Trash2 } from 'lucide-react';
import { useId, useRef, useState, type ChangeEvent } from 'react';
import { FileQuery } from '../api/operations';
import type { ShopFileData } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { TextArea } from '../products/product-form';
import { CheckField, SelectField } from '../settings/settings-form';
import { useAdminQuery } from '../shell/shop-context';
import { useImageUpload } from '../shell/use-image-upload';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { valueOf, type Setting } from './theme-files';

/** What a setting may point at in the shop: its menus and collections, by handle. */
export interface Choices {
  menus: { value: string; label: string }[];
  collections: { value: string; label: string }[];
}

const SIX_DIGITS = /^#[0-9a-f]{6}$/i;

/** An image setting's address: a path on the storefront, or a web address; null for none. */
function imageSrcOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (typeof value === 'object' && value !== null) {
    const src = (value as { src?: unknown }).src;
    return typeof src === 'string' ? src : null;
  }
  return null;
}

/** An image setting's words for those who cannot see it. */
function imageAltOf(value: unknown): string {
  const alt = typeof value === 'object' && value !== null && (value as { alt?: unknown }).alt;
  return typeof alt === 'string' ? alt : '';
}

/** Where the storefront shows a picture of the shop's (ADR-326): its file, then a name for people. */
const THEME_IMAGE = /^\/theme-images\/(file_[0-9a-z]+)(?:\/|$)/;

/** A file's name as part of an address: letters, digits and hyphens; "picture" for none. */
function nameForPath(name: string): string {
  const cut = name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return cut || 'picture';
}

/**
 * A picture setting (ADR-326): the picture it shows, a picture of the shop's from its own files
 * or one the theme came with; another uploaded from the phone, kept with the shop's files and
 * shown on its storefront at an address of its own; taken away; and its words for those who
 * cannot see it.
 */
function ImageSetting({
  label,
  info,
  value,
  onChange,
  storefront,
}: {
  label: string;
  info?: string;
  value: unknown;
  onChange: (value: unknown) => void;
  storefront: string;
}) {
  const { t } = useLocale();
  const upload = useImageUpload();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A picture just uploaded, shown from the phone until its file's address is asked for.
  const [chosen, setChosen] = useState<{ src: string; url: string } | null>(null);
  const src = imageSrcOf(value);
  const fileId = src ? THEME_IMAGE.exec(src)?.[1] : undefined;
  const local = chosen && chosen.src === src ? chosen.url : null;
  const file = useAdminQuery<ShopFileData>(
    ['file', fileId],
    FileQuery,
    { id: fileId ?? '' },
    { enabled: fileId !== undefined && local === null },
  );
  const shown = !src
    ? null
    : (local ?? (fileId ? (file.data?.file?.url ?? null) : new URL(src, storefront).toString()));
  const alt = imageAltOf(value);

  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    setBusy(true);
    setProblem(null);
    void upload(picked, label)
      .then((made) => {
        if ('problem' in made) {
          setProblem(made.problem);
          return;
        }
        const path = `/theme-images/${made.id}/${nameForPath(picked.name)}`;
        setChosen({ src: path, url: URL.createObjectURL(picked) });
        onChange({ src: path, alt });
      })
      .catch((failure: unknown) => setProblem(errorText(failure, t)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium">{label}</span>
      {shown ? (
        <img
          src={shown}
          alt=""
          className="max-h-40 self-start rounded-control border border-line object-contain"
        />
      ) : (
        !src && (
          <span className="flex items-center gap-2 text-secondary">
            <ImageOff aria-hidden className="size-5" />
            {t('editor.noImage')}
          </span>
        )
      )}
      {info && <p className="text-secondary">{info}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          icon={<ImageUp aria-hidden className="size-5" />}
          busy={busy}
          onClick={() => input.current?.click()}
        >
          {t(src ? 'editor.image.replace' : 'editor.image.choose')}
        </Button>
        {src && (
          <Button
            variant="danger"
            icon={<Trash2 aria-hidden className="size-5" />}
            disabled={busy}
            aria-label={t('editor.image.removeOf', { label })}
            onClick={() => onChange(undefined)}
          >
            {t('editor.image.remove')}
          </Button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        aria-label={label}
        onChange={onChosen}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      {src && (
        <TextField
          label={t('editor.image.alt', { label })}
          hint={t('editor.image.altHint')}
          dir="auto"
          value={alt}
          onChange={(event) => onChange({ src, alt: event.target.value })}
        />
      )}
    </div>
  );
}

/**
 * A setting of a theme's, its control by its type, as Shopify's theme editor offers them: words,
 * a number within its range, a choice, a tick, a colour, a link, a menu or a collection. Its
 * label, notes and choices are the theme's own, in the merchant's language where it has them.
 */
export function SettingField({
  setting,
  value,
  onChange,
  choices,
  storefront,
}: {
  setting: Setting;
  value: unknown;
  onChange: (value: unknown) => void;
  choices: Choices;
  /** Where the storefront is, for images at a path on it. */
  storefront: string;
}) {
  const { t } = useLocale();
  const id = useId();
  const label = setting.label ?? setting.id ?? setting.type;
  const text =
    typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  // A choice the shop no longer has stays chosen until another is.
  const among = (list: Choices['menus']) => [
    { value: '', label: t('editor.none') },
    ...list,
    ...(text && !list.some((each) => each.value === text) ? [{ value: text, label: text }] : []),
  ];

  switch (setting.type) {
    case 'header':
      return <h4 className="pt-2 font-semibold">{setting.content}</h4>;
    case 'paragraph':
      return <p className="text-secondary">{setting.content}</p>;
    case 'textarea':
    case 'richtext':
    case 'inline_richtext':
    case 'html':
      return (
        <div className="flex flex-col gap-1">
          <TextArea label={label} value={text} onChange={onChange} />
          {setting.info && <p className="text-secondary">{setting.info}</p>}
        </div>
      );
    case 'range': {
      const number = typeof value === 'number' ? value : Number(value ?? setting.min ?? 0);
      return (
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className="flex justify-between gap-2 font-medium">
            <span>{label}</span>
            <span className="num text-secondary" dir="ltr">
              {number}
              {setting.unit ?? ''}
            </span>
          </label>
          <input
            id={id}
            type="range"
            min={setting.min}
            max={setting.max}
            step={setting.step ?? 1}
            value={number}
            onChange={(event) => onChange(Number(event.target.value))}
            className="min-h-12 accent-[var(--hatti-color-primary)] md:min-h-10"
          />
          {setting.info && <p className="text-secondary">{setting.info}</p>}
        </div>
      );
    }
    case 'number':
      return (
        <TextField
          label={label}
          hint={setting.info}
          inputMode="numeric"
          ltr
          value={text}
          onChange={(event) => {
            const typed = event.target.value.trim();
            onChange(typed === '' || Number.isNaN(Number(typed)) ? typed : Number(typed));
          }}
        />
      );
    case 'checkbox':
      return (
        <CheckField
          label={label}
          hint={setting.info}
          checked={value === true}
          onChange={(checked) => onChange(checked)}
        />
      );
    case 'select':
    case 'radio':
      return (
        <SelectField
          label={label}
          value={text}
          options={(setting.options ?? []).map((option) => ({
            value: String(option.value),
            label: option.label ?? String(option.value),
          }))}
          onChange={onChange}
        />
      );
    case 'color':
      return (
        <div className="flex items-end gap-2">
          <input
            type="color"
            aria-label={label}
            value={SIX_DIGITS.test(text) ? text : '#000000'}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
            className="h-12 w-12 shrink-0 cursor-pointer rounded-control border border-line bg-surface md:h-10"
          />
          <TextField
            label={t('editor.colourCode', { label })}
            hint={setting.info}
            ltr
            className="min-w-0 flex-1"
            value={text}
            onChange={(event) => onChange(event.target.value.trim())}
          />
        </div>
      );
    case 'url':
      return (
        <TextField
          label={label}
          hint={setting.info ?? t('editor.urlHint')}
          ltr
          inputMode="url"
          autoCapitalize="none"
          placeholder="/collections/all"
          value={text}
          onChange={(event) => onChange(event.target.value.trim())}
        />
      );
    case 'link_list':
      return (
        <SelectField
          label={label}
          value={text}
          options={among(choices.menus)}
          onChange={onChange}
        />
      );
    case 'collection':
      return (
        <SelectField
          label={label}
          value={text}
          options={among(choices.collections)}
          onChange={onChange}
        />
      );
    case 'image_picker':
      return (
        <ImageSetting
          label={label}
          info={setting.info}
          value={value}
          onChange={onChange}
          storefront={storefront}
        />
      );
    default:
      // A kind the editor has no control for: words as words, anything else left as it is.
      return typeof value === 'object' && value !== null ? null : (
        <TextField
          label={label}
          hint={setting.info}
          dir="auto"
          placeholder={setting.placeholder}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

/** A section's, a block's or the theme's settings, in the order the theme gives them. */
export function SettingsForm({
  settings,
  values,
  onChange,
  choices,
  storefront,
}: {
  settings: readonly Setting[] | undefined;
  values: Readonly<Record<string, unknown>> | undefined;
  onChange: (setting: string, value: unknown) => void;
  choices: Choices;
  storefront: string;
}) {
  const { t } = useLocale();
  if (!settings?.length) return <p className="text-secondary">{t('editor.noSettings')}</p>;
  return (
    <div className="flex flex-col gap-4">
      {settings.map((setting, index) => (
        <SettingField
          key={setting.id ?? `${setting.type}-${index}`}
          setting={setting}
          value={valueOf(setting, values)}
          onChange={(value) => setting.id !== undefined && onChange(setting.id, value)}
          choices={choices}
          storefront={storefront}
        />
      ))}
    </div>
  );
}
