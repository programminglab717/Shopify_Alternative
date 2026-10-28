import { Minus, Plus, Printer, ScanBarcode, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { ApiError } from '../api/client';
import { PosCatalogQuery, PosSaleCreateMutation } from '../api/operations';
import type {
  PosCatalogData,
  PosRegisterValue,
  PosSaleCreateData,
  PosTenderMethod,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { QUEUED } from '../offline/outbox';
import { problemText } from '../products/product-form';
import {
  useAdminMutation,
  useAdminQuery,
  useShopDetails,
  useShopTimezone,
} from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { openPrintTab } from '../ui/print';
import {
  added,
  amountOf,
  byCode,
  matching,
  paisaOf,
  quickCash,
  totalsOf,
  type CartLine,
} from './cart';
import { receiptHtml, type ReceiptSale, type ReceiptWords } from './receipt';

export const METHODS: readonly PosTenderMethod[] = ['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET'];

export const METHOD_LABELS: Readonly<Record<PosTenderMethod, MessageKey>> = {
  CASH: 'pos.method.CASH',
  CARD: 'pos.method.CARD',
  BANK_TRANSFER: 'pos.method.BANK_TRANSFER',
  WALLET: 'pos.method.WALLET',
};

const money = (paisa: number) => formatMoney(amountOf(paisa));

/** The receipt's words, in the till's language. */
export function useReceiptWords(): ReceiptWords {
  const { t } = useLocale();
  return {
    receipt: t('pos.receipt'),
    pending: t('pos.receiptPending'),
    subtotal: t('pos.subtotal'),
    discount: t('pos.discount'),
    total: t('pos.total'),
    taxIncluded: t('pos.taxIncluded'),
    change: t('pos.change'),
    thanks: t('pos.thanks'),
    methods: Object.fromEntries(METHODS.map((method) => [method, t(METHOD_LABELS[method])])),
  };
}

/** A sale rung up, as its receipt shows it, and whether it waits on this device to be sent. */
interface Done {
  sale: ReceiptSale;
  kept: boolean;
}

/** Prints `sale`'s receipt in a tab of its own; false where the browser would not open one. */
export function usePrintReceipt(registerName: string) {
  const { locale } = useLocale();
  const shopName = useShopDetails()?.name ?? '';
  const timezone = useShopTimezone();
  const words = useReceiptWords();
  return (sale: ReceiptSale): boolean => {
    const tab = openPrintTab();
    if (!tab) return false;
    tab.show(
      receiptHtml(sale, {
        shopName,
        registerName,
        when: formatDateTime(sale.soldAt, timezone, locale),
        words,
        rtl: locale === 'ur',
      }),
    );
    return true;
  };
}

/**
 * Selling at the till (POS-01, POS-02, ADR-872): items found by name or scanned by barcode or
 * SKU from what the register sells, kept on the device for when it is offline; the cart, a
 * discount and the customer's number; then paid, with change from cash, and a receipt to print.
 * A sale made offline is kept on the device and sent once it is back, as the core keeps it once.
 */
export function Till({ register, sessionId }: { register: PosRegisterValue; sessionId: string }) {
  const { t } = useLocale();
  const catalog = useAdminQuery<PosCatalogData>(['posCatalog', register.id], PosCatalogQuery, {
    registerId: register.id,
  });
  const sell = useAdminMutation<PosSaleCreateData, { input: Record<string, unknown> }>(
    PosSaleCreateMutation,
  );
  const print = usePrintReceipt(register.name);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState('');
  const [phone, setPhone] = useState('');
  const [paying, setPaying] = useState(false);
  const [method, setMethod] = useState<PosTenderMethod>('CASH');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const items = useMemo(() => catalog.data?.posCatalog ?? [], [catalog.data]);
  const found = useMemo(() => matching(items, query), [items, query]);
  const totals = totalsOf(lines, paisaOf(discount));
  const paid = method === 'CASH' ? paisaOf(tendered || amountOf(totals.total)) : totals.total;

  const add = (item: (typeof items)[number]) => {
    setLines((current) => added(current, item));
    setQuery('');
    search.current?.focus();
  };
  // A scanner types the code and Enter: the item it names goes in the cart at once.
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const exact = byCode(items, query) ?? (found.length === 1 ? found[0]! : null);
    if (exact) add(exact);
    else if (query.trim()) setProblem(t('pos.notFound', { code: query.trim() }));
  };
  const change = (variantId: string, by: number) =>
    setLines((current) =>
      current
        .map((line) =>
          line.variantId === variantId ? { ...line, quantity: line.quantity + by } : line,
        )
        .filter((line) => line.quantity > 0),
    );
  const fresh = () => {
    setLines([]);
    setDiscount('');
    setPhone('');
    setPaying(false);
    setTendered('');
    setReference('');
    setProblem(null);
    setDone(null);
    search.current?.focus();
  };

  const complete = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const soldAt = new Date().toISOString();
    const tender = {
      method,
      amount: amountOf(paid),
      ...(method !== 'CASH' && reference.trim() && { reference: reference.trim() }),
    };
    const receipt: ReceiptSale = {
      name: null,
      soldAt,
      lines: lines.map((line) => ({
        title: line.title,
        variantTitle: line.variantTitle,
        quantity: line.quantity,
        total: line.unitPrice * line.quantity,
      })),
      subtotal: totals.subtotal,
      discount: totals.discount,
      tax: 0,
      total: totals.total,
      tenders: [{ method, amount: paid }],
      change: Math.max(paid - totals.total, 0),
    };
    try {
      const { posSaleCreate } = await sell.mutateAsync({
        input: {
          clientId: crypto.randomUUID(),
          sessionId,
          lines: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
          ...(totals.discount > 0 && { discount: amountOf(totals.discount) }),
          ...(phone.trim() && { customerPhone: phone.trim() }),
          tenders: [tender],
          soldAt,
        },
      });
      const error = posSaleCreate.userErrors[0];
      if (error || !posSaleCreate.sale) {
        setProblem(error ? problemText(error, t) : t('pos.notSold'));
        return;
      }
      const sale = posSaleCreate.sale;
      setDone({
        kept: false,
        sale: {
          ...receipt,
          name: sale.name,
          tax: paisaOf(sale.tax.amount),
          change: paisaOf(sale.changeGiven.amount),
        },
      });
    } catch (failure) {
      // Offline: the sale is kept on this device, and sent once it is back online.
      if (failure instanceof ApiError && failure.code === QUEUED) {
        setDone({ kept: true, sale: receipt });
        return;
      }
      setProblem(errorText(failure, t));
    }
  };

  if (catalog.isPending) return <Loading label={t('state.loading')} />;
  if (catalog.isError && !catalog.data) {
    return (
      <ErrorState
        message={errorText(catalog.error, t)}
        action={<Button onClick={() => void catalog.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }

  if (done) {
    return (
      <Card className="mx-auto flex w-full max-w-md flex-col gap-3 p-4">
        <h2 className="text-[length:var(--hatti-type-title-size)] font-semibold">
          {done.kept ? t('pos.keptTitle') : t('pos.soldTitle', { name: done.sale.name ?? '' })}
        </h2>
        {done.kept && <Alert tone="info">{t('pos.keptBody')}</Alert>}
        <p className="num text-[length:var(--hatti-type-display-size)] font-semibold">
          {money(done.sale.total)}
        </p>
        {done.sale.change > 0 && (
          <p className="num text-[length:var(--hatti-type-title-size)]">
            {t('pos.giveChange', { amount: money(done.sale.change) })}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<Printer aria-hidden className="size-5" />}
            onClick={() => {
              if (!print(done.sale)) setProblem(t('pos.printBlocked'));
            }}
          >
            {t('pos.printReceipt')}
          </Button>
          <Button onClick={fresh}>{t('pos.newSale')}</Button>
        </div>
        {problem && <Alert tone="warning">{problem}</Alert>}
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <section aria-label={t('pos.findItems')} className="flex flex-col gap-3">
        <TextField
          ref={search}
          label={t('pos.search')}
          hint={t('pos.searchHint')}
          type="search"
          autoFocus
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setProblem(null);
          }}
          onKeyDown={onSearchKey}
        />
        {catalog.isError && <Alert tone="warning">{t('pos.catalogKept')}</Alert>}
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('pos.items')}>
          {found.map((item) => (
            <li key={item.variantId}>
              <button
                type="button"
                aria-label={t('pos.addItem', { title: item.productTitle })}
                onClick={() => add(item)}
                className="flex w-full flex-col items-start gap-1 rounded-card border border-line bg-surface p-3 text-start hover:bg-canvas"
              >
                <span className="font-medium" dir="auto">
                  {item.productTitle}
                </span>
                {item.variantTitle !== 'Default Title' && (
                  <span className="text-secondary" dir="auto">
                    {item.variantTitle}
                  </span>
                )}
                <span className="num flex w-full justify-between gap-2">
                  <span>{formatMoney(item.price.amount)}</span>
                  {item.available !== null && (
                    <span className={item.available > 0 ? 'text-secondary' : 'text-warning'}>
                      {t('pos.onShelf', { count: item.available })}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {found.length === 0 && (
          <p className="flex items-center gap-2 text-secondary">
            <ScanBarcode aria-hidden className="size-5" />
            {t('pos.noneFound')}
          </p>
        )}
      </section>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-[length:var(--hatti-type-title-size)] font-semibold">
          {t('pos.cart')}
        </h2>
        {lines.length === 0 ? (
          <p className="text-secondary">{t('pos.cartEmpty')}</p>
        ) : (
          <ul aria-label={t('pos.cart')} className="flex flex-col divide-y divide-line">
            {lines.map((line) => (
              <li key={line.variantId} className="flex items-center gap-2 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium" dir="auto">
                    {line.title}
                  </span>
                  {line.variantTitle !== 'Default Title' && (
                    <span className="text-secondary" dir="auto">
                      {line.variantTitle}
                    </span>
                  )}
                  <span className="num text-secondary">
                    {line.quantity} × {money(line.unitPrice)}
                  </span>
                </span>
                <Button
                  variant="tertiary"
                  aria-label={t('pos.less', { title: line.title })}
                  icon={<Minus aria-hidden className="size-5" />}
                  onClick={() => change(line.variantId, -1)}
                />
                <span className="num w-6 text-center">{line.quantity}</span>
                <Button
                  variant="tertiary"
                  aria-label={t('pos.more', { title: line.title })}
                  icon={<Plus aria-hidden className="size-5" />}
                  onClick={() => change(line.variantId, 1)}
                />
                <Button
                  variant="danger"
                  aria-label={t('pos.remove', { title: line.title })}
                  icon={<Trash2 aria-hidden className="size-5" />}
                  onClick={() => change(line.variantId, -line.quantity)}
                />
              </li>
            ))}
          </ul>
        )}
        <TextField
          label={t('pos.discountAmount')}
          inputMode="decimal"
          ltr
          value={discount}
          onChange={(event) => setDiscount(event.target.value)}
        />
        <TextField
          label={t('pos.customerPhone')}
          hint={t('pos.customerPhoneHint')}
          inputMode="tel"
          ltr
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
        <dl className="num flex flex-col gap-1">
          <div className="flex justify-between">
            <dt>{t('pos.subtotal')}</dt>
            <dd>{money(totals.subtotal)}</dd>
          </div>
          {totals.discount > 0 && (
            <div className="flex justify-between">
              <dt>{t('pos.discount')}</dt>
              <dd>-{money(totals.discount)}</dd>
            </div>
          )}
          <div className="flex justify-between text-[length:var(--hatti-type-title-size)] font-semibold">
            <dt>{t('pos.total')}</dt>
            <dd>{money(totals.total)}</dd>
          </div>
        </dl>
        {!paying ? (
          <Button disabled={lines.length === 0} onClick={() => setPaying(true)}>
            {t('pos.charge', { amount: money(totals.total) })}
          </Button>
        ) : (
          <form onSubmit={(event) => void complete(event)} className="flex flex-col gap-3">
            <fieldset className="flex flex-wrap gap-2">
              <legend className="mb-1 font-medium">{t('pos.paidBy')}</legend>
              {METHODS.map((each) => (
                <Button
                  key={each}
                  variant={method === each ? 'primary' : 'secondary'}
                  aria-pressed={method === each}
                  onClick={() => setMethod(each)}
                >
                  {t(METHOD_LABELS[each])}
                </Button>
              ))}
            </fieldset>
            {method === 'CASH' ? (
              <>
                <TextField
                  label={t('pos.tendered')}
                  inputMode="decimal"
                  ltr
                  value={tendered}
                  placeholder={amountOf(totals.total)}
                  onChange={(event) => setTendered(event.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  {quickCash(totals.total).map((sum) => (
                    <Button
                      key={sum}
                      variant="secondary"
                      onClick={() => setTendered(amountOf(sum))}
                    >
                      {money(sum)}
                    </Button>
                  ))}
                </div>
                <p className="num font-medium">
                  {paid >= totals.total
                    ? t('pos.changeDue', { amount: money(paid - totals.total) })
                    : t('pos.stillDue', { amount: money(totals.total - paid) })}
                </p>
              </>
            ) : (
              <TextField
                label={t('pos.reference')}
                hint={t('pos.referenceHint')}
                ltr
                maxLength={100}
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
            )}
            {problem && <Alert tone="danger">{problem}</Alert>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" busy={sell.isPending} disabled={paid < totals.total}>
                {t('pos.complete')}
              </Button>
              <Button variant="tertiary" onClick={() => setPaying(false)}>
                {t('action.back')}
              </Button>
            </div>
          </form>
        )}
        {!paying && problem && <Alert tone="danger">{problem}</Alert>}
      </Card>
    </div>
  );
}
