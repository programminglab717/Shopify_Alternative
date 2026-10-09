/** Packing slips and invoices printed from the browser (ORD-06), as the core makes them. */
import { Printer } from 'lucide-react';
import { useId, useState } from 'react';
import { OrderDocumentQuery } from '../api/operations';
import type {
  DocumentLanguage,
  OrderDocumentData,
  OrderDocumentKind,
  PaperSize,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { SelectField } from '../settings/settings-form';
import { useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';
import { openPrintTab } from '../ui/print';

const KINDS: readonly OrderDocumentKind[] = ['PACKING_SLIP', 'INVOICE'];
const PAPERS: readonly PaperSize[] = ['A4', 'THERMAL_4X6', 'THERMAL_80MM'];
const LANGUAGES: readonly DocumentLanguage[] = ['BILINGUAL', 'ENGLISH', 'URDU'];

/** How the merchant last printed, kept in this browser so the next print starts from it. */
interface Choice {
  kind: OrderDocumentKind;
  paper: PaperSize;
  language: DocumentLanguage;
}

const STORAGE_KEY = 'hatti.print';
const FIRST: Choice = { kind: 'PACKING_SLIP', paper: 'A4', language: 'BILINGUAL' };

/** The choice kept from last time; browser storage may be missing or blocked. */
function keptChoice(): Choice {
  try {
    const kept = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Choice>;
    return {
      kind: KINDS.find((each) => each === kept?.kind) ?? FIRST.kind,
      paper: PAPERS.find((each) => each === kept?.paper) ?? FIRST.paper,
      language: LANGUAGES.find((each) => each === kept?.language) ?? FIRST.language,
    };
  } catch {
    return FIRST;
  }
}

function keepChoice(choice: Choice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Kept for this visit alone.
  }
}

/**
 * Packing slips or invoices for the orders given, a page each, on the paper and in the language
 * chosen, opened in a tab of their own to print; the choice is kept for the next print in this
 * browser.
 */
export function PrintPanel({
  ids,
  title,
  onDone,
}: {
  ids: readonly string[];
  title: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const store = useSessionStore();
  const shopId = useShop().id;
  const radios = useId();
  const [choice, setChoice] = useState<Choice>(keptChoice);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const print = async () => {
    setProblem(null);
    keepChoice(choice);
    // Opened while the tap is still being handled, so that pop-up blockers let it through.
    const tab = openPrintTab();
    if (!tab) {
      setProblem(t('shipping.popupBlocked'));
      return;
    }
    setBusy(true);
    try {
      const { orderDocument } = await store.graphql<OrderDocumentData>(shopId, OrderDocumentQuery, {
        ids: [...ids],
        ...choice,
      });
      tab.show(orderDocument.html);
      onDone();
    } catch (failure) {
      tab.close();
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="font-semibold">{title}</h2>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-medium">{t('print.kind')}</legend>
        {KINDS.map((kind) => (
          <label key={kind} className="flex min-h-10 items-start gap-2 py-1">
            <input
              type="radio"
              name={radios}
              checked={choice.kind === kind}
              onChange={() => setChoice((current) => ({ ...current, kind }))}
              className="mt-1 size-5 shrink-0 accent-[var(--hatti-color-primary)]"
            />
            <span className="flex flex-col">
              <span>{t(`print.kind.${kind}` as MessageKey)}</span>
              <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {t(`print.kind.${kind}.hint` as MessageKey)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-3 md:grid-cols-2">
        <SelectField<PaperSize>
          label={t('print.paper')}
          value={choice.paper}
          options={PAPERS.map((paper) => ({
            value: paper,
            label: t(`print.paper.${paper}` as MessageKey),
          }))}
          onChange={(paper) => setChoice((current) => ({ ...current, paper }))}
        />
        <SelectField<DocumentLanguage>
          label={t('print.language')}
          value={choice.language}
          options={LANGUAGES.map((language) => ({
            value: language,
            label: t(`print.language.${language}` as MessageKey),
          }))}
          onChange={(language) => setChoice((current) => ({ ...current, language }))}
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          busy={busy}
          icon={<Printer aria-hidden className="size-5" />}
          onClick={() => void print()}
        >
          {t('print.go')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </Card>
  );
}
