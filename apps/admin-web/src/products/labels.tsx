/** Price labels for the products chosen, printed from the browser, and barcodes given (CAT-22). */
import { Barcode, Printer } from 'lucide-react';
import { useState } from 'react';
import { ProductLabelsQuery, ProductVariantsBarcodesGiveMutation } from '../api/operations';
import type {
  ProductLabelPaper,
  ProductLabelsData,
  ProductVariantsBarcodesGiveData,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';
import { TextField } from '../ui/field';
import { openPrintTab } from '../ui/print';

const PAPERS: readonly ProductLabelPaper[] = ['A4_SHEET', 'ROLL_50X25'];
/** The most labels the core lays out at once. */
const LABELS_MAX = 1000;
const STORAGE_KEY = 'hatti.labels';

/** The paper last printed on in this browser; storage may be missing or blocked. */
function keptPaper(): ProductLabelPaper {
  try {
    const kept = window.localStorage.getItem(STORAGE_KEY);
    return PAPERS.find((each) => each === kept) ?? 'A4_SHEET';
  } catch {
    return 'A4_SHEET';
  }
}

function keepPaper(paper: ProductLabelPaper): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, paper);
  } catch {
    // Kept for this visit alone.
  }
}

/** A product chosen on the list, with its variants: a label is printed for each. */
export interface LabelledProduct {
  id: string;
  variants: readonly { id: string }[];
}

/**
 * Labels for every variant of the products chosen, as many of each as asked, on a sheet of A4 or
 * a label printer's roll, opened in a tab of their own to print; and barcodes of the shop's own
 * given to the variants without, so that every label has one to scan.
 */
export function LabelsPanel({
  products,
  onDone,
}: {
  products: readonly LabelledProduct[];
  onDone: () => void;
}) {
  const { t } = useLocale();
  const store = useSessionStore();
  const shopId = useShop().id;
  const give = useAdminMutation<ProductVariantsBarcodesGiveData, { productIds: string[] }>(
    ProductVariantsBarcodesGiveMutation,
  );
  const [paper, setPaper] = useState<ProductLabelPaper>(keptPaper);
  const [copies, setCopies] = useState('1');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [given, setGiven] = useState<string | null>(null);

  const variantIds = products.flatMap((product) => product.variants.map((variant) => variant.id));
  const each = /^\d+$/.test(copies.trim()) ? Number(copies.trim()) : 0;
  const total = each * variantIds.length;
  const copiesError =
    each < 1
      ? t('labels.copiesInvalid')
      : total > LABELS_MAX
        ? t('labels.tooMany', { max: formatCount(LABELS_MAX) })
        : null;

  const giveBarcodes = async () => {
    setProblem(null);
    setGiven(null);
    try {
      const { productVariantsBarcodesGive: payload } = await give.mutateAsync({
        productIds: products.map((product) => product.id),
      });
      if (payload.userErrors.length > 0) setProblem(payload.userErrors[0]!.message);
      else
        setGiven(
          t('labels.barcodesDone', {
            given: formatCount(payload.given),
            had: formatCount(payload.had),
          }),
        );
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const print = async () => {
    setProblem(null);
    keepPaper(paper);
    // Opened while the tap is still being handled, so that pop-up blockers let it through.
    const tab = openPrintTab();
    if (!tab) {
      setProblem(t('shipping.popupBlocked'));
      return;
    }
    setBusy(true);
    try {
      const { productLabels } = await store.graphql<ProductLabelsData>(shopId, ProductLabelsQuery, {
        items: variantIds.map((variantId) => ({ variantId, copies: each })),
        paper,
      });
      tab.show(productLabels.html);
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
      <h2 className="font-semibold">{t('labels.title', { count: products.length })}</h2>
      <p className="text-secondary">{t('labels.hint')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <SelectField<ProductLabelPaper>
          label={t('labels.paper')}
          value={paper}
          options={PAPERS.map((each) => ({
            value: each,
            label: t(`labels.paper.${each}` as MessageKey),
          }))}
          onChange={setPaper}
        />
        <TextField
          label={t('labels.copies')}
          hint={copiesError ? undefined : t('labels.count', { count: formatCount(total) })}
          error={copiesError}
          inputMode="numeric"
          ltr
          value={copies}
          onChange={(event) => setCopies(event.target.value)}
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {given && <Alert tone="success">{given}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          busy={busy}
          disabled={copiesError !== null || give.isPending}
          icon={<Printer aria-hidden className="size-5" />}
          onClick={() => void print()}
        >
          {t('labels.print')}
        </Button>
        <Button
          variant="secondary"
          busy={give.isPending}
          disabled={busy}
          icon={<Barcode aria-hidden className="size-5" />}
          onClick={() => void giveBarcodes()}
        >
          {t('labels.barcodes')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('labels.barcodesHint')}
      </p>
    </Card>
  );
}
