import { FileUp, ScanText } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { browserFetch } from '../api/client';
import {
  CustomerStoreCreditQuery,
  OrderCreateManualPaymentMutation,
  OrderMarkAsPaidMutation,
  OrderPayWithStoreCreditMutation,
  OrderRefundMutation,
  OrderWaiveAdvanceMutation,
  StagedUploadsCreateMutation,
  TransferReceiptReadMutation,
} from '../api/operations';
import type {
  CustomerStoreCreditData,
  OrderCreateManualPaymentData,
  OrderDetail,
  OrderPayWithStoreCreditData,
  OrderStage,
  OrderWaiveAdvanceData,
  ParcelUserErrorsData,
  RefundMethod,
  StagedUploadsCreateData,
  TransferReceiptReadData,
  TransferReceiptValue,
} from '../api/types';
import { can, gate, permits } from '../auth/permissions';
import { formatDate, formatDateTime, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { parsePrice, priceText, problemText } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';

/** Those who record money received for an order, or mark it paid (`write_orders`). */
export const HANDLES_MONEY = gate(['owner', 'manager'], 'write_orders');

/** Those who give money back, and settle refunds a gateway never answered (`refund_orders`). */
export const REFUNDS = gate(['owner', 'manager'], 'refund_orders');

/** Those who pay for an order with its customer's store credit. */
const PAYS_WITH_CREDIT = gate(
  ['owner', 'manager'],
  (shop) => can(shop, 'write_orders') && can(shop, 'write_store_credit_account_transactions'),
);

/** Ways staff give money back; EXCHANGE is a return's own. */
const METHODS: readonly RefundMethod[] = [
  'CASH',
  'BANK_TRANSFER',
  'MOBILE_WALLET',
  'ONLINE',
  'STORE_CREDIT',
  'OTHER',
];

/** Ways money moves by staff's hand, which keep a reference and a receipt. */
const SENT_BY_HAND: readonly RefundMethod[] = ['CASH', 'BANK_TRANSFER', 'MOBILE_WALLET', 'OTHER'];

/** A receipt the core keeps: a photo, a screenshot or a PDF of at most 10 MiB (ADR-242). */
/** The stages of an order with nothing of it shipped yet, which store credit may still pay. */
const UNSHIPPED: readonly OrderStage[] = [
  'NEEDS_CONFIRMATION',
  'NEEDS_REVIEW',
  'AWAITING_PAYMENT',
  'TO_PACK',
  'TO_BOOK',
  'READY_FOR_PICKUP',
];

const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const RECEIPT_BYTES = 10 * 1024 * 1024;

export const cents = (amount: string) => Math.round(Number(amount) * 100);

/**
 * What the order waits for by transfer before it ships, as the core works it out: the whole of a
 * transfer's or an online payment's total, a cash-on-delivery order's advance; less what came.
 */
export function transferOwed(
  order: Pick<OrderDetail, 'paymentMethod' | 'totalPrice' | 'advanceDue' | 'amountPaid'>,
): string {
  const awaited =
    order.paymentMethod === 'BANK_TRANSFER' || order.paymentMethod === 'ONLINE'
      ? cents(order.totalPrice.amount)
      : order.paymentMethod === 'CASH_ON_DELIVERY'
        ? cents(order.advanceDue.amount)
        : 0;
  const left = awaited - cents(order.amountPaid.amount);
  return left > 0 ? (left / 100).toFixed(2) : '0';
}

/** What can still be given back: paid, less refunded. */
export function refundable(order: Pick<OrderDetail, 'amountPaid' | 'amountRefunded'>): string {
  const left = cents(order.amountPaid.amount) - cents(order.amountRefunded.amount);
  return left > 0 ? (left / 100).toFixed(2) : '0';
}

/**
 * Money given back (ORD-09, ADR-184, ADR-242): how much, at most what is left, and how; a
 * transfer's reference and its receipt, uploaded as it is chosen; through the gateway, or as
 * store credit, where the core records its own.
 */
export function RefundForm({
  order,
  most,
  forReturn,
  onDone,
}: {
  order: OrderDetail;
  most: string;
  /** The customer return it gives money back for (ADR-613): not online, which the core refuses. */
  forReturn?: { id: string; name: string };
  onDone: (message: string) => void;
}) {
  const { t } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState(priceText(most));
  const [method, setMethod] = useState<RefundMethod>(
    order.paymentMethod === 'ONLINE' && !forReturn ? 'ONLINE' : 'BANK_TRANSFER',
  );
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [receiptProblem, setReceiptProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const stage = useAdminMutation<StagedUploadsCreateData, Record<string, unknown>>(
    StagedUploadsCreateMutation,
  );
  const refund = useAdminMutation<ParcelUserErrorsData, Record<string, unknown>>(
    OrderRefundMutation,
  );
  const { problem, attempt } = useAttempt();
  const parsed = parsePrice(amount);
  const tooMuch = parsed !== null && cents(parsed) > cents(most);
  const byHand = SENT_BY_HAND.includes(method);
  const ready = parsed !== null && cents(parsed) > 0 && !tooMuch && !uploading;

  const onChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    setReceiptProblem(null);
    if (file && !RECEIPT_TYPES.includes(file.type)) {
      setReceiptProblem(t('money.receipt.type'));
      return;
    }
    if (file && file.size > RECEIPT_BYTES) {
      setReceiptProblem(t('money.receipt.size'));
      return;
    }
    setReceipt(file);
  };

  /** The receipt staged and put to storage; its resourceUrl for the refund, or why not. */
  const uploaded = async (file: File): Promise<string> => {
    const { stagedUploadsCreate } = await stage.mutateAsync({
      input: [{ filename: file.name, mimeType: file.type, fileSize: String(file.size) }],
    });
    const target = stagedUploadsCreate.stagedTargets?.[0];
    if (!target) {
      const error = stagedUploadsCreate.userErrors[0];
      throw new Error(error ? problemText(error, t) : t('state.error'));
    }
    const response = await browserFetch(target.url, {
      method: target.httpMethod,
      headers: Object.fromEntries(target.parameters.map((each) => [each.name, each.value])),
      body: file,
    });
    if (!response.ok) throw new Error(t('photos.uploadFailed', { name: file.name }));
    return target.resourceUrl;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const done = await attempt(async () => {
      let receiptUrl: string | null = null;
      if (byHand && receipt) {
        setUploading(true);
        try {
          receiptUrl = await uploaded(receipt);
        } finally {
          setUploading(false);
        }
      }
      return (
        await refund.mutateAsync({
          id: order.id,
          input: {
            amount: parsed,
            method,
            ...(byHand && reference.trim() ? { reference: reference.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(receiptUrl ? { receipt: receiptUrl } : {}),
            ...(forReturn ? { returnId: forReturn.id } : {}),
          },
        })
      ).orderRefund!;
    });
    if (done) onDone(t('money.refunded', { amount: formatMoney(parsed!) }));
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      {forReturn && <p className="text-secondary">{t('money.refund.forReturn', forReturn)}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        <TextField
          label={t('money.amount', { most: formatMoney(most) })}
          inputMode="decimal"
          ltr
          value={amount}
          error={
            amount && parsed === null
              ? t('returns.claim.amountWrong')
              : tooMuch
                ? t('money.tooMuch')
                : null
          }
          onChange={(event) => setAmount(event.target.value)}
        />
        <SelectField<RefundMethod>
          label={t('money.method')}
          value={method}
          options={METHODS.filter((each) => !forReturn || each !== 'ONLINE').map((each) => ({
            value: each,
            label: t(`money.method.${each}` as MessageKey),
          }))}
          onChange={setMethod}
        />
      </div>
      {method === 'ONLINE' && <p className="text-secondary">{t('money.online.hint')}</p>}
      {method === 'STORE_CREDIT' && <p className="text-secondary">{t('money.credit.hint')}</p>}
      {byHand && (
        <>
          <TextField
            label={t('money.reference')}
            hint={t('money.reference.hint')}
            ltr
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              icon={<FileUp aria-hidden className="size-5" />}
              onClick={() => input.current?.click()}
            >
              {t(receipt ? 'money.receipt.another' : 'money.receipt.choose')}
            </Button>
            {receipt && (
              <span className="min-w-0 truncate" dir="auto">
                {receipt.name}
              </span>
            )}
            <input
              ref={input}
              type="file"
              accept={RECEIPT_TYPES.join(',')}
              className="hidden"
              aria-label={t('money.receipt')}
              onChange={onChosen}
            />
          </div>
          {receiptProblem && <Alert tone="danger">{receiptProblem}</Alert>}
        </>
      )}
      <TextField
        label={t('money.note')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={refund.isPending || uploading} disabled={!ready}>
          {t('money.refund.save')}
        </Button>
        <Button variant="tertiary" onClick={() => onDone('')}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * An order's money (ORD-09): what was paid and given back, each refund with how, its reference,
 * why and its receipt; an order recorded as paid, once its money came in; and money given back.
 * Owners and managers.
 */
/**
 * Money the customer sent, recorded by hand (CHK-10, PAY-02): what the order waits for by transfer
 * unless staff say otherwise, else the rest, at most what it owes. Its advance or its transfer in,
 * the order moves on to be packed, and on delivery the courier collects the rest.
 */
function RecordPayment({
  order,
  owed,
  onDone,
}: {
  order: OrderDetail;
  owed: string;
  onDone: (message: string) => void;
}) {
  const { t } = useLocale();
  const waiting = transferOwed(order);
  const [amount, setAmount] = useState(priceText(cents(waiting) > 0 ? waiting : owed));
  const record = useAdminMutation<OrderCreateManualPaymentData, { id: string; amount: string }>(
    OrderCreateManualPaymentMutation,
  );
  const { problem, attempt } = useAttempt();
  const parsed = parsePrice(amount);
  const tooMuch = parsed !== null && cents(parsed) > cents(owed);
  const ready = parsed !== null && cents(parsed) > 0 && !tooMuch;
  const hint =
    cents(waiting) === 0
      ? undefined
      : order.paymentMethod === 'CASH_ON_DELIVERY'
        ? t('money.record.hintAdvance')
        : t('money.record.hintTransfer');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const ok = await attempt(
      async () =>
        (await record.mutateAsync({ id: order.id, amount: parsed! })).orderCreateManualPayment,
    );
    if (ok) onDone(t('money.record.done', { amount: formatMoney(parsed!) }));
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <TextField
        label={t('money.amount', { most: formatMoney(owed) })}
        hint={hint}
        inputMode="decimal"
        ltr
        value={amount}
        error={
          amount && parsed === null
            ? t('returns.claim.amountWrong')
            : tooMuch
              ? t('money.record.tooMuch', { owed: formatMoney(owed) })
              : null
        }
        onChange={(event) => setAmount(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={record.isPending} disabled={!ready}>
          {t('money.record.save')}
        </Button>
        <Button variant="tertiary" onClick={() => onDone('')}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The order paid, or part of it, with its customer's store credit (ADR-185): as much as it owes
 * and the credit covers unless staff say less. On delivery, the cash at the door drops by it.
 */
function PayWithCredit({
  order,
  balance,
  owed,
  onDone,
}: {
  order: OrderDetail;
  balance: string;
  owed: string;
  onDone: (message: string) => void;
}) {
  const { t } = useLocale();
  const most = cents(balance) < cents(owed) ? balance : owed;
  const [amount, setAmount] = useState(priceText(most));
  const pay = useAdminMutation<OrderPayWithStoreCreditData, { id: string; amount: string }>(
    OrderPayWithStoreCreditMutation,
  );
  const { problem, attempt } = useAttempt();
  const parsed = parsePrice(amount);
  const tooMuch = parsed !== null && cents(parsed) > cents(most);
  const ready = parsed !== null && cents(parsed) > 0 && !tooMuch;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const ok = await attempt(
      async () =>
        (await pay.mutateAsync({ id: order.id, amount: parsed! })).orderPayWithStoreCredit,
    );
    if (ok) onDone(t('money.credit.paid', { amount: formatMoney(parsed!) }));
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <p>{t('money.credit.has', { balance: formatMoney(balance), owed: formatMoney(owed) })}</p>
      <TextField
        label={t('money.amount', { most: formatMoney(most) })}
        inputMode="decimal"
        ltr
        value={amount}
        error={
          amount && parsed === null
            ? t('returns.claim.amountWrong')
            : tooMuch
              ? t('money.tooMuch')
              : null
        }
        onChange={(event) => setAmount(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={pay.isPending} disabled={!ready}>
          {t('money.credit.pay')}
        </Button>
        <Button variant="tertiary" onClick={() => onDone('')}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * What a customer's receipt says, as the AI read it, beside what Hatti makes of it (PAY-08,
 * ADR-845): its amount against what the order waited for, the account it went to, its reference
 * on other orders' receipts, a day before the order. Unread, those who handle money read it for
 * a credit. A reading is a help to check, never a payment: staff mark the order paid themselves.
 */
function ReceiptReading({ receipt, handles }: { receipt: TransferReceiptValue; handles: boolean }) {
  const { t } = useLocale();
  const read = useAdminMutation<TransferReceiptReadData, { id: string }>(
    TransferReceiptReadMutation,
  );
  const { problem, attempt } = useAttempt();
  const reading = receipt.reading ?? null;
  const small = 'text-[length:var(--hatti-type-body-sm-size)]';
  if (reading?.outcome === 'NOT_A_RECEIPT') {
    return <span className={`text-warning ${small}`}>{t('money.reading.notReceipt')}</span>;
  }
  if (reading?.outcome === 'READ') {
    const amountWarns = reading.amountCheck === 'SHORT' || reading.amountCheck === 'OVER';
    return (
      <dl className={`flex max-w-72 flex-col gap-0.5 ${small}`}>
        <dt className="font-medium">{t('money.reading.title')}</dt>
        {reading.amount && (
          <dd>
            <span className="num">{formatMoney(reading.amount.amount)}</span>
            {reading.amountCheck === 'MATCHES' && (
              <span className="text-success"> · {t('money.reading.amountMatches')}</span>
            )}
            {amountWarns && reading.owed && (
              <span className="text-danger">
                {' · '}
                {t(
                  reading.amountCheck === 'SHORT'
                    ? 'money.reading.amountShort'
                    : 'money.reading.amountOver',
                  { amount: formatMoney(reading.owed.amount) },
                )}
              </span>
            )}
          </dd>
        )}
        {reading.paidOn && (
          <dd>
            <span dir="ltr">{reading.paidOn}</span>
            {reading.beforeOrder && (
              <span className="text-danger"> · {t('money.reading.beforeOrder')}</span>
            )}
          </dd>
        )}
        {reading.reference && (
          <dd>
            {t('money.reading.reference')} <span dir="ltr">{reading.reference}</span>
            {reading.sameReferenceOrders.length > 0 && (
              <span className="text-danger">
                {' · '}
                {t('money.reading.sameReference', {
                  orders: reading.sameReferenceOrders.join(', '),
                })}
              </span>
            )}
          </dd>
        )}
        {(reading.senderName || reading.senderBank) && (
          <dd>
            {t('money.reading.from')}{' '}
            <span dir="auto">
              {[reading.senderName, reading.senderBank].filter(Boolean).join(' · ')}
            </span>
          </dd>
        )}
        {(reading.recipientName || reading.recipientAccount) && (
          <dd>
            {t('money.reading.to')}{' '}
            <span dir="auto">
              {[reading.recipientName, reading.recipientAccount].filter(Boolean).join(' · ')}
            </span>
            {reading.accountCheck === 'MATCHES' && (
              <span className="text-success"> · {t('money.reading.accountMatches')}</span>
            )}
            {reading.accountCheck === 'DIFFERS' && (
              <span className="text-danger"> · {t('money.reading.accountDiffers')}</span>
            )}
          </dd>
        )}
        <dd className="text-secondary">{t('money.reading.check')}</dd>
      </dl>
    );
  }
  if (!handles || !receipt.readable) return null;
  return (
    <div className="flex max-w-72 flex-col gap-1">
      <Button
        variant="tertiary"
        icon={<ScanText aria-hidden className="size-4" />}
        busy={read.isPending}
        onClick={() =>
          void attempt(
            async () => (await read.mutateAsync({ id: receipt.id })).transferReceiptRead!,
          )
        }
      >
        {t('money.reading.read')}
      </Button>
      <span className={`text-secondary ${small}`}>
        {reading?.outcome === 'FAILED' ? t('money.reading.failed') : t('money.reading.credit')}
      </span>
      {problem && <span className={`text-danger ${small}`}>{problem}</span>}
    </div>
  );
}

export function OrderMoney({ order, timezone }: { order: OrderDetail; timezone: string }) {
  const { t, locale } = useLocale();
  const shop = useShop();
  const [open, setOpen] = useState<'refund' | 'paid' | 'credit' | 'record' | 'waive' | null>(null);
  const [done, setDone] = useState('');
  const markPaid = useAdminMutation<ParcelUserErrorsData, { id: string }>(OrderMarkAsPaidMutation);
  const waive = useAdminMutation<OrderWaiveAdvanceData, { id: string }>(OrderWaiveAdvanceMutation);
  const { problem, attempt } = useAttempt();
  const handles = permits(shop, HANDLES_MONEY);
  const refunds = permits(shop, REFUNDS);
  const most = refundable(order);
  const unpaid =
    order.status !== 'CANCELLED' && cents(order.amountPaid.amount) < cents(order.totalPrice.amount);
  const owed = ((cents(order.totalPrice.amount) - cents(order.amountPaid.amount)) / 100).toFixed(2);
  // What it waits for by transfer before it ships: its advance, or the transfer's total.
  const waiting = order.stage === 'AWAITING_PAYMENT' ? transferOwed(order) : '0';
  const advance = order.paymentMethod === 'CASH_ON_DELIVERY' && cents(waiting) > 0;
  // Store credit pays an order still open with nothing of it shipped.
  const creditPays =
    permits(shop, PAYS_WITH_CREDIT) &&
    unpaid &&
    order.customer !== null &&
    UNSHIPPED.includes(order.stage);
  const credit = useAdminQuery<CustomerStoreCreditData>(
    ['customerStoreCredit', order.customer?.id, false],
    CustomerStoreCreditQuery,
    { id: order.customer?.id },
    { enabled: creditPays },
  );
  const balance =
    credit.data?.customer?.storeCreditAccounts.nodes.find(
      (account) => account.balance.currencyCode === order.totalPrice.currencyCode,
    )?.balance.amount ?? '0.00';
  const hasCredit = creditPays && cents(balance) > 0;

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-1">
        <div className="flex justify-between gap-4">
          <dt className="text-secondary">{t('money.paid')}</dt>
          <dd className="num">{formatMoney(order.amountPaid.amount)}</dd>
        </div>
        {cents(order.amountRefunded.amount) > 0 && (
          <div className="flex justify-between gap-4">
            <dt className="text-secondary">{t('money.refundedTotal')}</dt>
            <dd className="num">-{formatMoney(order.amountRefunded.amount)}</dd>
          </div>
        )}
      </dl>
      {cents(waiting) > 0 && (
        <p className="font-medium">
          {t(advance ? 'money.waitsAdvance' : 'money.waitsTransfer', {
            amount: formatMoney(waiting),
          })}
        </p>
      )}
      {order.transferReceipts.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-secondary">{t('money.receipts')}</span>
          <ul className="flex flex-wrap gap-3">
            {order.transferReceipts.map((receipt, index) => {
              const name = t('money.receiptNumber', { number: index + 1 });
              return (
                <li key={receipt.id} className="flex flex-col gap-1">
                  <a
                    href={receipt.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {receipt.mimeType.startsWith('image/') ? (
                      <img
                        src={receipt.url}
                        alt={name}
                        loading="lazy"
                        className="max-h-40 rounded-control border border-line"
                      />
                    ) : (
                      t('money.receiptPdf', { number: index + 1 })
                    )}
                  </a>
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {formatDateTime(receipt.createdAt, timezone, locale)}
                  </span>
                  <ReceiptReading receipt={receipt} handles={handles} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {order.refunds.length > 0 && (
        <ul className="flex flex-col divide-y divide-line">
          {order.refunds.map((refund) => (
            <li key={refund.id} className="flex flex-col gap-0.5 py-2">
              <span className="flex flex-wrap justify-between gap-x-3">
                <span className="font-medium">
                  {t(`money.method.${refund.method}` as MessageKey)}
                </span>
                <span className="num">{formatMoney(refund.amount.amount)}</span>
              </span>
              <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                {formatDate(refund.createdAt, timezone, locale)}
                {/* Store credit's reference is its transaction's ID, nothing a merchant reads. */}
                {refund.reference && refund.method !== 'STORE_CREDIT' && (
                  <>
                    {' · '}
                    <span dir="ltr">{refund.reference}</span>
                  </>
                )}
                {refund.note && (
                  <>
                    {' · '}
                    <span dir="auto">{refund.note}</span>
                  </>
                )}
              </span>
              {refund.creditNote && (
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t('money.creditNote')}{' '}
                  <span dir="ltr" className="num">
                    {refund.creditNote.number}
                  </span>
                </span>
              )}
              {refund.receipt && (
                <a
                  href={refund.receipt.url}
                  target="_blank"
                  rel="noreferrer"
                  className="self-start underline"
                >
                  {t('money.receipt.open')}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {done && <Alert tone="success">{done}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {refunds && open === 'refund' && (
        <RefundForm
          order={order}
          most={most}
          onDone={(message) => {
            setOpen(null);
            setDone(message);
          }}
        />
      )}
      {hasCredit && open === 'credit' && (
        <PayWithCredit
          order={order}
          balance={balance}
          owed={owed}
          onDone={(message) => {
            setOpen(null);
            setDone(message);
          }}
        />
      )}
      {handles && open === 'record' && (
        <RecordPayment
          order={order}
          owed={owed}
          onDone={(message) => {
            setOpen(null);
            setDone(message);
          }}
        />
      )}
      {handles && open === 'paid' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1">{t('money.paid.confirm', { amount: formatMoney(owed) })}</span>
          <Button
            busy={markPaid.isPending}
            onClick={() =>
              void attempt(
                async () => (await markPaid.mutateAsync({ id: order.id })).orderMarkAsPaid!,
              ).then((ok) => {
                setOpen(null);
                if (ok) setDone(t('money.paid.done'));
              })
            }
          >
            {t('money.paid.mark')}
          </Button>
          <Button variant="tertiary" onClick={() => setOpen(null)}>
            {t('returns.cancel')}
          </Button>
        </div>
      )}
      {handles && advance && open === 'waive' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1">
            {t('money.waive.confirm', { amount: formatMoney(waiting) })}
          </span>
          <Button
            busy={waive.isPending}
            onClick={() =>
              void attempt(
                async () => (await waive.mutateAsync({ id: order.id })).orderWaiveAdvance!,
              ).then((ok) => {
                setOpen(null);
                if (ok) setDone(t('money.waive.done'));
              })
            }
          >
            {t('money.waive.mark')}
          </Button>
          <Button variant="tertiary" onClick={() => setOpen(null)}>
            {t('returns.cancel')}
          </Button>
        </div>
      )}
      {open === null && ((handles && unpaid) || hasCredit || (refunds && cents(most) > 0)) && (
        <div className="flex flex-wrap gap-2">
          {hasCredit && (
            <Button
              variant="secondary"
              onClick={() => {
                setDone('');
                setOpen('credit');
              }}
            >
              {t('money.credit.start', { balance: formatMoney(balance) })}
            </Button>
          )}
          {handles && unpaid && (
            <Button
              variant={cents(waiting) > 0 ? 'primary' : 'secondary'}
              onClick={() => {
                setDone('');
                setOpen('record');
              }}
            >
              {t('money.record.start')}
            </Button>
          )}
          {/* Paid in full would leave the courier nothing to collect: not while it waits for its advance. */}
          {handles && unpaid && !advance && (
            <Button
              variant="secondary"
              onClick={() => {
                setDone('');
                setOpen('paid');
              }}
            >
              {t('money.paid.start')}
            </Button>
          )}
          {/* A customer the shop trusts: the courier collects the advance with the rest (ADR-653). */}
          {handles && advance && (
            <Button
              variant="secondary"
              onClick={() => {
                setDone('');
                setOpen('waive');
              }}
            >
              {t('money.waive.start')}
            </Button>
          )}
          {refunds && cents(most) > 0 && (
            <Button
              variant="secondary"
              onClick={() => {
                setDone('');
                setOpen('refund');
              }}
            >
              {t('money.refund.start')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
