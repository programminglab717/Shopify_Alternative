import { useState } from 'react';
import { PhotoSearchQuery, PhotoSearchSetMutation } from '../api/operations';
import type { PhotoSearchData, PhotoSearchSetData } from '../api/types';
import { can } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Alert, Loading } from '../ui/feedback';

/**
 * Search by photo (SRC-07, ADR-870): whether the shop's search reads a shopper's photo into
 * words, each photo one of its AI credits; the theme's search section shows the button.
 */
export function PhotoSearchSection() {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<PhotoSearchData>(['photoSearch'], PhotoSearchQuery);
  const save = useAdminMutation<PhotoSearchSetData, { enabled: boolean }>(PhotoSearchSetMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const writes = can(shop, 'write_settings');

  const body = () => {
    if (query.isPending) return <Loading label={t('state.loading')} />;
    if (query.isError) return <Alert tone="danger">{errorText(query.error, t)}</Alert>;
    const setting = query.data.photoSearch;
    if (!setting.available) return <p className="text-secondary">{t('photoSearch.unavailable')}</p>;
    return (
      <>
        {writes ? (
          <CheckField
            label={t('photoSearch.enabled')}
            hint={t('photoSearch.enabledHint')}
            checked={setting.enabled}
            onChange={(enabled) => {
              setProblem(null);
              save.mutateAsync({ enabled }).catch((error: unknown) => {
                setProblem(errorText(error, t));
              });
            }}
          />
        ) : (
          <p>{t(setting.enabled ? 'photoSearch.on' : 'photoSearch.off')}</p>
        )}
        <p className="text-secondary">
          {t('photoSearch.usage', { used: setting.usedToday, limit: setting.limitPerDay })}
        </p>
        {setting.enabled && <p className="text-secondary">{t('photoSearch.theme')}</p>}
        {problem && <Alert tone="danger">{problem}</Alert>}
      </>
    );
  };

  return (
    <FormSection title={t('photoSearch.title')} hint={t('photoSearch.intro')}>
      {body()}
    </FormSection>
  );
}
