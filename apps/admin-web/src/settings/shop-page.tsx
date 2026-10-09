import { ImageUp, Store, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
  OnlineStorePreferencesUpdateMutation,
  ShopBrandUpdateMutation,
  ShopDetailsQuery,
} from '../api/operations';
import type { ShopDetailsData, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatPhone } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { useImageUpload } from '../shell/use-image-upload';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { BackToSettings } from './settings-page';

type LogoKind = 'logo' | 'squareLogo';

/** One of the shop's logos: shown, replaced by a photo the merchant chooses, or taken away. */
function LogoField({
  kind,
  current,
}: {
  kind: LogoKind;
  current: { id: string; url: string } | null;
}) {
  const { t } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const uploadImage = useImageUpload();
  const update = useAdminMutation<
    { shopBrandUpdate: { userErrors: UserError[] } },
    { input: Partial<Record<LogoKind, string | null>> }
  >(ShopBrandUpdateMutation);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Runs `step`, which says what went wrong, or null when all went well. */
  const attempt = async (step: () => Promise<string | null>) => {
    setBusy(true);
    setProblem(null);
    try {
      setProblem(await step());
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const setLogo = async (id: string | null) => {
    const { shopBrandUpdate } = await update.mutateAsync({ input: { [kind]: id } });
    const error = shopBrandUpdate.userErrors[0];
    return error ? problemText(error, t) : null;
  };

  const upload = (file: File) =>
    attempt(async () => {
      const made = await uploadImage(file, t(`shop.${kind}` as MessageKey));
      return 'problem' in made ? made.problem : setLogo(made.id);
    });

  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void upload(file);
  };

  return (
    <FormSection title={t(`shop.${kind}` as MessageKey)} hint={t(`shop.${kind}Hint` as MessageKey)}>
      <div className="flex flex-wrap items-center gap-4">
        <div
          className={`flex items-center justify-center overflow-hidden rounded-control border border-line bg-canvas ${
            kind === 'squareLogo' ? 'size-24' : 'h-24 w-48'
          }`}
        >
          {current ? (
            <img
              src={current.url}
              alt={t(`shop.${kind}` as MessageKey)}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <Store aria-hidden className="size-8 text-secondary" />
          )}
        </div>
        <div className="flex flex-col gap-2">
          {!current && <p className="text-secondary">{t('shop.noLogo')}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon={<ImageUp aria-hidden className="size-5" />}
              busy={busy}
              onClick={() => input.current?.click()}
            >
              {t(current ? 'shop.replace' : 'shop.choose')}
            </Button>
            {current && (
              <Button
                variant="danger"
                icon={<Trash2 aria-hidden className="size-5" />}
                disabled={busy}
                onClick={() => void attempt(() => setLogo(null))}
              >
                {t('shop.removeLogo')}
              </Button>
            )}
          </div>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label={t(`shop.${kind}` as MessageKey)}
          onChange={onChosen}
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </FormSection>
  );
}

/** Where the storefront's "Order on WhatsApp" links go. */
function WhatsappField({ current }: { current: string | null }) {
  const { t } = useLocale();
  const update = useAdminMutation<
    {
      onlineStorePreferencesUpdate: {
        preferences: { whatsappNumber: string | null } | null;
        userErrors: UserError[];
      };
    },
    { input: { whatsappNumber: string | null } }
  >(OnlineStorePreferencesUpdateMutation);
  const [number, setNumber] = useState(current ? formatPhone(current) : '');
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    try {
      const { onlineStorePreferencesUpdate } = await update.mutateAsync({
        input: { whatsappNumber: number.trim() || null },
      });
      const error = onlineStorePreferencesUpdate.userErrors[0];
      if (error) setProblem(error.message);
      else {
        const kept = onlineStorePreferencesUpdate.preferences?.whatsappNumber ?? null;
        setNumber(kept ? formatPhone(kept) : '');
        setSaved(true);
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('shop.whatsapp')} hint={t('shop.whatsappHint')}>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <TextField
          label={t('shop.whatsappNumber')}
          type="tel"
          inputMode="tel"
          placeholder="0300 1234567"
          autoComplete="off"
          ltr
          value={number}
          onChange={(event) => setNumber(event.target.value)}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && <Alert tone="success">{t('shop.whatsappSaved')}</Alert>}
        <Button type="submit" busy={update.isPending} className="self-start">
          {t('product.save')}
        </Button>
      </form>
    </FormSection>
  );
}

/**
 * The shop as customers see it beyond its theme: its logo, which checkout and customers' links
 * show in place of its name (ADR-081); its square logo, atop its link page (ADR-205); and the
 * WhatsApp number its storefront's links go to.
 */
export function ShopPage() {
  const { t } = useLocale();
  const query = useAdminQuery<ShopDetailsData>(['shopDetails'], ShopDetailsQuery);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { brand } = query.data.shop;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.shop')}
      </h1>
      <LogoField kind="logo" current={brand.logo} />
      <LogoField kind="squareLogo" current={brand.squareLogo} />
      <WhatsappField current={query.data.onlineStorePreferences.whatsappNumber} />
    </div>
  );
}
