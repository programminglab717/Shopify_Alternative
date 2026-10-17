import { useLocale } from '../i18n/locale';
import { Pair } from '../settings/settings-form';
import { TextField } from '../ui/field';

/** Buy X get Y's quantities (ADR-519): items bought and items given in each group. */
export function BuyGetFields({
  buy,
  get,
  onBuy,
  onGet,
}: {
  buy: string;
  get: string;
  onBuy: (value: string) => void;
  onGet: (value: string) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col gap-1">
      <Pair>
        <TextField
          label={t('buyGet.buy')}
          required
          inputMode="numeric"
          ltr
          value={buy}
          onChange={(event) => onBuy(event.target.value)}
        />
        <TextField
          label={t('buyGet.get')}
          required
          inputMode="numeric"
          ltr
          value={get}
          onChange={(event) => onGet(event.target.value)}
        />
      </Pair>
      <p className="text-secondary">{t('buyGet.hint')}</p>
    </div>
  );
}
