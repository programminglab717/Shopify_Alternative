import { useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api/client';
import { ME_KEY, useSessionStore } from '../auth/context';
import type { ShopAccess } from '../auth/session';
import { TermsAgreement, useTermsAgreement } from '../shops/terms-agreement';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';

/**
 * Asks a shop's owner to agree to Hatti's terms as they are now (ADR-739), when they have yet to
 * for this shop: it was handed to them, it opened before agreements were kept, or the terms
 * changed since. The box and its links are those of opening a shop (ADR-737); the rest of the
 * admin stays open meanwhile.
 */
export function TermsBanner({ shop }: { shop: ShopAccess }) {
  if (!shop.agreementDue) return null;
  return <TermsDue shopId={shop.id} />;
}

function TermsDue({ shopId }: { shopId: string }) {
  const { t } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const agreement = useTermsAgreement();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!agreement.agreed) return;
    setBusy(true);
    setError(null);
    try {
      await store.auth(`/auth/shops/${encodeURIComponent(shopId)}/agreement`, {
        body: { agreed: agreement.agreed },
      });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
    } catch (failure) {
      setError(errorText(failure, t));
      if (failure instanceof ApiError && failure.code === 'TERMS_CHANGED') {
        await agreement.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t('terms.dueTitle')} className="px-4 pt-4 md:px-6">
      <form
        onSubmit={(event) => void onSubmit(event)}
        className="flex flex-col gap-3 rounded-control border-s-4 border-warning bg-surface p-3"
      >
        <div className="flex items-start gap-2">
          <FileText aria-hidden className="mt-0.5 size-5 shrink-0 text-secondary" />
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="font-semibold">{t('terms.dueTitle')}</h2>
            <p className="text-secondary">{t('terms.dueBody')}</p>
          </div>
        </div>
        <TermsAgreement agreement={agreement} />
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" busy={busy} className="self-start">
          {t('terms.dueSubmit')}
        </Button>
      </form>
    </section>
  );
}
