import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { DoorClosed } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { ME_KEY, useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';
import { TextField } from '../ui/field';

/**
 * The owner closes the shop (ADR-740), typing its name, once they have confirmed who they are:
 * its storefront, checkout and admin stop, and its data stays 90 days, during which they may
 * reopen it from their shops. Shown to its owner alone.
 */
export function CloseShop() {
  const { t } = useLocale();
  const shop = useShop();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { run, panel } = useRecentAuthentication();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (shop.role !== 'owner') return null;
  const named = name.trim() === shop.name.trim();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!named) return;
    setProblem(null);
    setBusy(true);
    void run(
      async () => {
        await store.auth(`/auth/shops/${encodeURIComponent(shop.id)}/close`, {
          body: { name: name.trim() },
        });
        await queryClient.invalidateQueries({ queryKey: ME_KEY });
        await navigate({ to: '/shops' });
      },
      (failure) => setProblem(errorText(failure, t)),
    ).finally(() => setBusy(false));
  };

  return (
    <Card className="border-danger p-4">
      <form onSubmit={onSubmit} aria-labelledby="close-shop" className="flex flex-col gap-3">
        <h2 id="close-shop" className="inline-flex items-center gap-2 font-semibold">
          <DoorClosed aria-hidden className="size-5" />
          {t('closeShop.title')}
        </h2>
        <p className="text-secondary">{t('closeShop.body')}</p>
        <TextField
          label={t('closeShop.typeName', { name: shop.name })}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Button
          type="submit"
          variant="destructive"
          busy={busy}
          disabled={!named}
          className="self-start"
        >
          {t('closeShop.submit')}
        </Button>
      </form>
      {panel}
    </Card>
  );
}
