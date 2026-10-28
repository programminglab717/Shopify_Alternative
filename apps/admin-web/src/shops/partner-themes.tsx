import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ThemeStoreOfferMutation, ThemesQuery } from '../api/operations';
import type { ThemeStoreOfferData, ThemesData } from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';
import { TextField } from '../ui/field';
import type { PartnerStore } from './partner-page';

/** A partner's theme in the theme store, as they see it (OS-20, ADR-853). */
export interface PartnerTheme {
  id: string;
  name: string;
  description: string;
  /** Paisa, as a string; "0" for a free theme. */
  price: string;
  listed: boolean;
  shopId: string;
  themeId: string;
  updatedAt: string;
}

const KEY = ['partner', 'themes'] as const;

/** "Rs 5,000" of paisa as a string. */
const rupeesOf = (paisa: string) => formatMoney((BigInt(paisa) / 100n).toString());

/**
 * The partner's themes in the theme store (ADR-853): each with whether Hatti listed it, and a way
 * to offer a theme of one of their development stores, copied as it is then, free or for a price.
 */
export function PartnerThemes({ stores }: { stores: PartnerStore[] }) {
  const { t } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const themes = useQuery({
    queryKey: KEY,
    queryFn: () => store.auth<{ themes: PartnerTheme[] }>('/auth/partner/themes'),
  });
  // Its development stores not yet handed over, in which they work.
  const building = stores.filter((each) => each.kind === 'development' && each.role);
  const [shopId, setShopId] = useState(building[0]?.id ?? '');
  const ofStore = useQuery({
    queryKey: ['partner', 'store-themes', shopId],
    queryFn: () => store.graphql<ThemesData>(shopId, ThemesQuery),
    enabled: shopId !== '',
  });
  const [themeId, setThemeId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('0');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const storeThemes = ofStore.data?.themes.nodes ?? [];
  const chosen = themeId || storeThemes[0]?.id || '';

  const onOffer = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaid(null);
    setProblem(null);
    try {
      const { themeStoreOffer: done } = await store.graphql<ThemeStoreOfferData>(
        shopId,
        ThemeStoreOfferMutation,
        {
          themeId: chosen,
          input: { name: name.trim(), description: description.trim(), price: price.trim() },
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      if (done.userErrors[0]) setProblem(problemText(done.userErrors[0], t));
      else {
        setSaid(t('partnerThemes.offered', { name: done.listing!.name }));
        await queryClient.invalidateQueries({ queryKey: KEY });
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="partner-themes" className="flex flex-col gap-2">
      <h2 id="partner-themes" className="font-semibold">
        {t('partnerThemes.title')}
      </h2>
      <p className="text-secondary">{t('partnerThemes.hint')}</p>
      {(themes.data?.themes ?? []).map((theme) => (
        <Card key={theme.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3">
          <span className="flex-1 font-medium" dir="auto">
            {theme.name}
          </span>
          <span className="num">
            {theme.price === '0' ? t('themeStore.free') : rupeesOf(theme.price)}
          </span>
          <span className="text-secondary">
            {t(theme.listed ? 'partnerThemes.listed' : 'partnerThemes.waiting')}
          </span>
        </Card>
      ))}
      {themes.isError && <Alert tone="danger">{errorText(themes.error, t)}</Alert>}
      {building.length === 0 ? (
        <p className="text-secondary">{t('partnerThemes.noStore')}</p>
      ) : (
        <form onSubmit={(event) => void onOffer(event)} className="flex flex-col gap-3">
          <SelectField
            label={t('partnerThemes.store')}
            value={shopId}
            options={building.map((each) => ({ value: each.id, label: each.name }))}
            onChange={(value) => {
              setShopId(value);
              setThemeId('');
            }}
          />
          <SelectField
            label={t('partnerThemes.theme')}
            value={chosen}
            options={storeThemes.map((theme) => ({ value: theme.id, label: theme.name }))}
            onChange={setThemeId}
          />
          <TextField
            label={t('partnerThemes.name')}
            dir="auto"
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <TextField
            label={t('partnerThemes.description')}
            dir="auto"
            maxLength={1000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <TextField
            label={t('partnerThemes.price')}
            inputMode="numeric"
            dir="ltr"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            required
          />
          {said && <Alert tone="success">{said}</Alert>}
          {problem && <Alert tone="danger">{problem}</Alert>}
          <Button type="submit" className="self-start" busy={busy} disabled={!chosen}>
            {t('partnerThemes.offer')}
          </Button>
        </form>
      )}
    </section>
  );
}
