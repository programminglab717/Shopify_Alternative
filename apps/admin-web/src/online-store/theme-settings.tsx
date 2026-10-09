import { ImageOff } from 'lucide-react';
import { useId } from 'react';
import { useLocale } from '../i18n/locale';
import { TextArea } from '../products/product-form';
import { CheckField, SelectField } from '../settings/settings-form';
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
    case 'image_picker': {
      const src = imageSrcOf(value);
      return (
        <div className="flex flex-col gap-1">
          <span className="font-medium">{label}</span>
          {src ? (
            <img
              src={new URL(src, storefront).toString()}
              alt=""
              className="max-h-40 self-start rounded-control border border-line object-contain"
            />
          ) : (
            <span className="flex items-center gap-2 text-secondary">
              <ImageOff aria-hidden className="size-5" />
              {t('editor.noImage')}
            </span>
          )}
          <p className="text-secondary">{t('editor.imageSoon')}</p>
        </div>
      );
    }
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
