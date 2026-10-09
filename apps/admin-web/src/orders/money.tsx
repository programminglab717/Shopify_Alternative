import { FileUp } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { browserFetch } from '../api/client';
import {
  CustomerStoreCreditQuery,
  OrderMarkAsPaidMutation,
  OrderPayWithStoreCreditMutation,
  OrderRefundMutation,
  StagedUploadsCreateMutation,
} from '../api/operations';
import type {
  CustomerStoreCreditData,
  OrderDetail,
  OrderPayWithStoreCreditData,
  OrderStage,
  ParcelUserErrorsData,
  RefundMethod,
  StagedUploadsCreateData,
} from '../api/types';
import type { StaffRole } from '../auth/session';
import { formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { parsePrice, priceText, problemText } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';

/** Those who give money back or record it received, as the core lets them for refunds. */
export const HANDLES_MONEY: readonly StaffRole[] = ['owner', 'manager'];

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
];

const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const RECEIPT_BYTES = 10 * 1024 * 1024;

const cents = (amount: string) => Math.round(Number(amount) * 100);

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
function RefundForm({
  order,
  most,
  onDone,
}: {
  order: OrderDetail;
  most: string;
  onDone: (message: string) => void;
}) {
  const { t } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState(priceText(most));
  const [method, setMethod] = useState<RefundMethod>(
    order.paymentMethod === 'ONLINE' ? 'ONLINE' : 'BANK_TRANSFER',
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
          },
        })
      ).orderRefund!;
    });
    if (done) onDone(t('money.refunded', { amount: formatMoney(parsed!) }));
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
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
          options={METHODS.map((each) => ({
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

export function OrderMoney({ order, timezone }: { order: OrderDetail; timezone: string }) {
  const { t, locale } = useLocale();
  const { role } = useShop();
  const [open, setOpen] = useState<'refund' | 'paid' | 'credit' | null>(null);
  const [done, setDone] = useState('');
  const markPaid = useAdminMutation<ParcelUserErrorsData, { id: string }>(OrderMarkAsPaidMutation);
  const { problem, attempt } = useAttempt();
  const handles = HANDLES_MONEY.includes(role);
  const most = refundable(order);
  const unpaid =
    order.status !== 'CANCELLED' && cents(order.amountPaid.amount) < cents(order.totalPrice.amount);
  const owed = ((cents(order.totalPrice.amount) - cents(order.amountPaid.amount)) / 100).toFixed(2);
  // Store credit pays an order still open with nothing of it shipped.
  const creditPays =
    handles && unpaid && order.customer !== null && UNSHIPPED.includes(order.stage);
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
      {handles && open === 'refund' && (
        <RefundForm
          order={order}
          most={most}
          onDone={(message) => {
            setOpen(null);
            setDone(message);
          }}
        />
      )}
      {handles && open === 'credit' && (
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
      {handles && open === null && (unpaid || cents(most) > 0) && (
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
          {unpaid && (
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
          {cents(most) > 0 && (
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
