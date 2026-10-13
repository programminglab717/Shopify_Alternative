import { Package, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ProductBundleSetMutation } from '../api/operations';
import type {
  ProductBundleComponent,
  ProductBundleSetData,
  ProductDetail,
  UserError,
} from '../api/types';
import { ProductPicker } from '../drafts/new-draft-page';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection } from './product-form';

/** A part as the card keeps it: its variant, its name to show, and how many as typed. */
interface Part {
  variantId: string;
  title: string;
  quantity: string;
}

/** Most of one part a set may hold (ADR-409). */
const MOST = 99;

/** "Lawn shirt · M", or the product's title alone where it has no options. */
export function partTitle(part: Pick<ProductBundleComponent, 'productTitle' | 'variantTitle'>) {
  return part.variantTitle === 'Default Title'
    ? part.productTitle
    : `${part.productTitle} · ${part.variantTitle}`;
}

function partsOf(components: readonly ProductBundleComponent[]): Part[] {
  return components.map((part) => ({
    variantId: part.variantId,
    title: partTitle(part),
    quantity: String(part.quantity),
  }));
}

const same = (a: readonly Part[], b: readonly Part[]) =>
  a.length === b.length &&
  a.every(
    (part, index) => part.variantId === b[index]!.variantId && part.quantity === b[index]!.quantity,
  );

/** The core's words for a part's problem, the part named where it is one (ADR-409). */
function bundleProblem(error: UserError, parts: readonly Part[]): string {
  const field = error.field ?? [];
  const index = field[0] === 'components' ? Number(field[1]) : Number.NaN;
  const part = Number.isInteger(index) ? parts[index] : undefined;
  return part ? `${part.title}: ${error.message}` : error.message;
}

/**
 * A product sold as a set of the shop's other products (CAT-11, ADR-409): a 3-piece suit of a
 * shirt, a dupatta and a trouser, or a multipack of three of one. Its parts are found as a draft's
 * items are, each with how many one set holds; with none, it is no bundle.
 */
export function ProductBundleCard({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const set = useAdminMutation<
    ProductBundleSetData,
    { productId: string; components: { variantId: string; quantity: number }[] }
  >(ProductBundleSetMutation);
  const [stored, setStored] = useState(() => partsOf(product.bundle?.components ?? []));
  const [complete, setComplete] = useState(product.bundle?.complete ?? true);
  const [parts, setParts] = useState(stored);
  const [picking, setPicking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean | undefined>(undefined);
  const changed = !same(parts, stored);

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(undefined);
    const quantities = parts.map((part) => Number(part.quantity));
    if (
      quantities.some((quantity) => !Number.isInteger(quantity) || quantity < 1 || quantity > MOST)
    ) {
      setProblem(t('bundle.quantity', { most: MOST }));
      return;
    }
    try {
      const { productBundleSet } = await set.mutateAsync({
        productId: product.id,
        components: parts.map((part, index) => ({
          variantId: part.variantId,
          quantity: quantities[index]!,
        })),
      });
      const error = productBundleSet.userErrors[0];
      if (error) {
        setProblem(bundleProblem(error, parts));
        return;
      }
      const now = partsOf(productBundleSet.bundle?.components ?? []);
      setStored(now);
      setParts(now);
      setComplete(productBundleSet.bundle?.complete ?? true);
      setSaved(productBundleSet.bundle !== null);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('bundle.title')} hint={t('bundle.hint')}>
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        {!complete && <Alert tone="warning">{t('bundle.incomplete')}</Alert>}
        {parts.length === 0 ? (
          <p className="text-secondary">{t('bundle.none')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
            {parts.map((part, index) => (
              <li key={part.variantId} className="flex items-end gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 self-center" dir="auto">
                  {part.title}
                </span>
                <TextField
                  label={t('bundle.quantityOf', { title: part.title })}
                  className="w-24 [&>label]:sr-only"
                  inputMode="numeric"
                  ltr
                  value={part.quantity}
                  onChange={(event) =>
                    setParts(
                      parts.map((each, at) =>
                        at === index ? { ...each, quantity: event.target.value } : each,
                      ),
                    )
                  }
                />
                <Button
                  variant="tertiary"
                  icon={<Trash2 aria-hidden className="size-5" />}
                  aria-label={t('bundle.remove', { title: part.title })}
                  onClick={() => setParts(parts.filter((_, at) => at !== index))}
                />
              </li>
            ))}
          </ul>
        )}
        {picking ? (
          <ProductPicker
            onAdd={(picked) => {
              setPicking(false);
              // The same variant again holds one more of it.
              const at = parts.findIndex((part) => part.variantId === picked.variantId);
              setParts(
                at >= 0
                  ? parts.map((part, index) =>
                      index === at
                        ? { ...part, quantity: String(Number(part.quantity) + 1) }
                        : part,
                    )
                  : [...parts, { variantId: picked.variantId, title: picked.title, quantity: '1' }],
              );
            }}
          />
        ) : (
          <Button
            variant="secondary"
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => setPicking(true)}
          >
            {t('bundle.addPart')}
          </Button>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved !== undefined && !changed && (
          <Alert tone="success">{saved ? t('bundle.savedOn') : t('bundle.savedOff')}</Alert>
        )}
        <Button
          type="submit"
          className="self-start"
          busy={set.isPending}
          disabled={!changed}
          icon={<Package aria-hidden className="size-5" />}
        >
          {t('bundle.save')}
        </Button>
      </form>
    </FormSection>
  );
}
