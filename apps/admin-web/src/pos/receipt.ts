import { formatMoney } from '../i18n/format';
import { amountOf } from './cart';

// The till's receipt (POS-01, ADR-872): an 80 mm page, as a thermal printer takes it, built on the
// device from the sale, so that a sale made offline prints too. Printed from a tab of its own.

export interface ReceiptSale {
  /** "#P12"; null for a sale kept on the device until it is sent. */
  name: string | null;
  soldAt: string;
  lines: { title: string; variantTitle: string; quantity: number; total: number }[];
  /** In paisa. */
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  tenders: { method: string; amount: number }[];
  change: number;
}

export interface ReceiptWords {
  receipt: string;
  pending: string;
  subtotal: string;
  discount: string;
  total: string;
  taxIncluded: string;
  change: string;
  thanks: string;
  methods: Readonly<Record<string, string>>;
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const money = (paisa: number) => formatMoney(amountOf(paisa));

/** The receipt's page, whole, for a tab to print. */
export function receiptHtml(
  sale: ReceiptSale,
  {
    shopName,
    registerName,
    when,
    words,
    rtl,
  }: { shopName: string; registerName: string; when: string; words: ReceiptWords; rtl: boolean },
): string {
  const row = (label: string, value: string, strong = false) =>
    `<tr${strong ? ' class="strong"' : ''}><td>${escape(label)}</td><td class="n">${escape(value)}</td></tr>`;
  const lines = sale.lines
    .map(
      (line) =>
        `<tr><td>${line.quantity} × ${escape(line.title)}${
          line.variantTitle && line.variantTitle !== 'Default Title'
            ? `<br><small>${escape(line.variantTitle)}</small>`
            : ''
        }</td><td class="n">${escape(money(line.total))}</td></tr>`,
    )
    .join('');
  const totals = [
    row(words.subtotal, money(sale.subtotal)),
    sale.discount > 0 ? row(words.discount, `-${money(sale.discount)}`) : '',
    row(words.total, money(sale.total), true),
    sale.tax > 0 ? row(words.taxIncluded, money(sale.tax)) : '',
    ...sale.tenders.map((tender) =>
      row(words.methods[tender.method] ?? tender.method, money(tender.amount)),
    ),
    sale.change > 0 ? row(words.change, money(sale.change)) : '',
  ].join('');
  return `<!doctype html><html lang="${rtl ? 'ur' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${escape(words.receipt)} ${escape(sale.name ?? '')}</title>
<style>@page{size:80mm auto;margin:4mm}body{font:13px/1.4 system-ui,sans-serif;width:72mm;margin:0 auto;color:#000}
h1{font-size:16px;text-align:center;margin:0 0 4px}p{margin:0;text-align:center}table{width:100%;border-collapse:collapse;margin-top:8px}
td{padding:2px 0;vertical-align:top}.n{text-align:end;white-space:nowrap}.strong td{font-weight:700;border-top:1px dashed #000;padding-top:4px}
small{color:#333}.foot{margin-top:10px}</style></head><body>
<h1>${escape(shopName)}</h1><p>${escape(registerName)}</p>
<p>${escape(words.receipt)} ${escape(sale.name ?? words.pending)} · ${escape(when)}</p>
<table>${lines}</table><table>${totals}</table><p class="foot">${escape(words.thanks)}</p></body></html>`;
}
