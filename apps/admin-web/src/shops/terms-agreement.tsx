import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { useSessionStore } from '../auth/context';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';

// Hatti's terms that opening a shop agrees to (ADR-737): the terms of service, the acceptable use
// policy and the data processing agreement, each linked to its page, a box to tick, and the
// versions agreed to once ticked.

export const AGREEMENT_KEY = ['auth', 'agreement'] as const;

interface AgreementDocument {
  handle: string;
  version: string;
  url: string;
}

const NAMES: Record<string, MessageKey> = {
  terms: 'terms.doc.terms',
  'acceptable-use': 'terms.doc.acceptableUse',
  'data-processing': 'terms.doc.dataProcessing',
};

/** The documents to agree to, whether the box is ticked, and the versions agreed to. */
export function useTermsAgreement() {
  const store = useSessionStore();
  const query = useQuery({
    queryKey: AGREEMENT_KEY,
    queryFn: () =>
      store.auth<{ documents: AgreementDocument[] }>('/auth/agreement', { method: 'GET' }),
    staleTime: 5 * 60_000,
  });
  const [checked, setChecked] = useState(false);
  const documents = query.data?.documents ?? [];
  const agreed =
    checked && documents.length > 0
      ? Object.fromEntries(documents.map((document) => [document.handle, document.version]))
      : null;
  return {
    documents,
    checked,
    setChecked,
    agreed,
    /** After the terms changed under the page: untick, and show them as they are now. */
    refresh: async () => {
      setChecked(false);
      await query.refetch();
    },
  };
}

/** The box: "I agree to Hatti's terms of service, acceptable use policy and data processing agreement." */
export function TermsAgreement({ agreement }: { agreement: ReturnType<typeof useTermsAgreement> }) {
  const { t } = useLocale();
  const { documents } = agreement;
  return (
    <label className="flex items-start gap-3 text-sm">
      <input
        type="checkbox"
        checked={agreement.checked}
        onChange={(event) => agreement.setChecked(event.target.checked)}
        disabled={documents.length === 0}
        required
        className="mt-1 size-5 shrink-0 accent-[var(--hatti-color-primary)]"
      />
      <span>
        {t('terms.agreeStart')}{' '}
        {documents.map((document, index) => (
          <Fragment key={document.handle}>
            {index > 0 &&
              (index === documents.length - 1 ? ` ${t('terms.and')} ` : t('terms.comma'))}
            <a href={document.url} target="_blank" rel="noreferrer" className="underline">
              {NAMES[document.handle] ? t(NAMES[document.handle]!) : document.handle}
            </a>
          </Fragment>
        ))}
        {t('terms.agreeEnd')}
      </span>
    </label>
  );
}
