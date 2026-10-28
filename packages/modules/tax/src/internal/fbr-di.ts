// FBR's digital invoicing (TAX-04, ADR-562): what a seller registered for sales tax sends FBR of
// each invoice it issues, as PRAL's DI API takes it. Everything FBR sets is here, as FBR's
// "Technical Specification for DI API" (v1.12) has it: its addresses, its words for invoices,
// sales and provinces, and its codes. A shop proves them in FBR's sandbox, through FBR's scenarios,
// before it reports in production. Amounts here are in minor units; FBR is sent rupees.
import { fbrDateTime, rupees, type FbrEnvironment, type FiscalDocument } from './fbr.js';
import type { TaxProvince } from './tax.js';

/** Where FBR's digital invoicing takes invoices, in each environment. */
export const FBR_DI_URLS: Record<FbrEnvironment, string> = {
  production: 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata',
  sandbox: 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata_sb',
};

/** FBR's words for an invoice: digital invoicing has sale invoices and debit notes alone. */
const INVOICE_TYPE = 'Sale Invoice';

/** Why a credit note is not sent: digital invoicing takes none. */
export const DI_NO_CREDIT_NOTES =
  "Not reported: FBR's digital invoicing takes no credit notes, which go in the sales tax return";

/**
 * The scenario the sandbox checks an invoice against, sent there alone: SN002, goods at the
 * standard rate to an unregistered buyer, as the shop's customers are.
 */
export const DI_SANDBOX_SCENARIO = 'SN002';

/** The buyer, a consumer: unregistered, without an NTN or CNIC. */
const BUYER_REGISTRATION = 'Unregistered';

/** The buyer's name where the order has none left, its customer's data erased. */
const UNNAMED_BUYER = 'Customer';

/** FBR's unit for goods counted as pieces. */
const UNIT = 'Numbers, pieces, units';

/**
 * FBR's kinds of sale: goods taxed at the standard rate, at a reduced rate under an SRO
 * (ADR-895), or not taxed.
 */
const SALE_TYPES = {
  taxed: 'Goods at standard rate (default)',
  reduced: 'Goods at Reduced Rate',
  untaxed: 'Exempt goods',
} as const;

/** FBR's rate for an item not taxed. */
const UNTAXED_RATE = 'Exempt';

/** FBR's code for an invoice, or an item of it, that is valid; "01" is invalid. */
export const DI_VALID = '00';

/** FBR's names of provinces, by the province a shop's business is registered in (ADR-500). */
export const DI_PROVINCES: Record<TaxProvince, string> = {
  punjab: 'Punjab',
  sindh: 'Sindh',
  khyber_pakhtunkhwa: 'Khyber Pakhtunkhwa',
  balochistan: 'Balochistan',
  islamabad: 'Islamabad Capital Territory',
  gilgit_baltistan: 'Gilgit-Baltistan',
  azad_kashmir: 'Azad Jammu and Kashmir',
};

/** Addresses' province codes, as @hatti/pk has them, as provinces. */
const ADDRESS_PROVINCES: Record<string, TaxProvince> = {
  PB: 'punjab',
  SD: 'sindh',
  KP: 'khyber_pakhtunkhwa',
  BA: 'balochistan',
  IS: 'islamabad',
  GB: 'gilgit_baltistan',
  JK: 'azad_kashmir',
};

/** An item as digital invoicing takes it; without an HS code of its own, the shop's goes. */
export interface DiItemBody {
  hsCode?: string;
  productDescription: string;
  rate: string;
  uoM: string;
  quantity: number;
  totalValues: number;
  valueSalesExcludingST: number;
  fixedNotifiedValueOrRetailPrice: number;
  salesTaxApplicable: number;
  salesTaxWithheldAtSource: number;
  extraTax: string;
  furtherTax: number;
  sroScheduleNo: string;
  fedPayable: number;
  discount: number;
  saleType: string;
  sroItemSerialNo: string;
}

/** An invoice as digital invoicing takes it, but the sandbox's scenario and items' HS code. */
export interface DiInvoiceBody {
  invoiceType: string;
  invoiceDate: string;
  sellerNTNCNIC: string;
  sellerBusinessName: string;
  sellerProvince: string;
  sellerAddress: string;
  buyerNTNCNIC: string;
  buyerBusinessName: string;
  buyerProvince: string;
  buyerAddress: string;
  buyerRegistrationType: string;
  invoiceRefNo: string;
  items: DiItemBody[];
}

/** An invoice as FBR is sent it: in the sandbox, its scenario; the shop's HS code where none. */
export type DiInvoiceRequest = Omit<DiInvoiceBody, 'items'> & {
  scenarioId?: string;
  items: (DiItemBody & { hsCode: string })[];
};

/**
 * The seller, as its tax settings and the shop directory have it when it issued the invoice: its
 * NTN and province are blank where its tax settings have none, and the invoice is not sent so.
 */
export interface DiSeller {
  /** Its NTN as the shop keeps it, "1234567-8", or a sole trader's CNIC. */
  ntn: string | null;
  businessName: string;
  province: TaxProvince | null;
}

/**
 * An NTN as digital invoicing takes it: its seven digits, without the check digit, or a CNIC's
 * 13 digits.
 */
export function diNtnOf(ntn: string): string {
  const digits = ntn.replace(/\D/g, '');
  return digits.length === 8 ? digits.slice(0, 7) : digits;
}

/** A PCT code's 8 digits as digital invoicing writes HS codes: "6204.4200". */
export function diHsCodeOf(pctCode: string): string {
  return `${pctCode.slice(0, 4)}.${pctCode.slice(4)}`;
}

/** A rate in hundredths of a percent as FBR writes it: "18%", "17.5%"; null for none. */
export function diRateOf(rate: number | null): string {
  return rate === null ? UNTAXED_RATE : `${rate / 100}%`;
}

/** FBR's name of the province an address's code `code` names; null for one not known. */
export function diProvinceOf(code: string | null | undefined): string | null {
  const province = code ? ADDRESS_PROVINCES[code.toUpperCase()] : undefined;
  return province ? DI_PROVINCES[province] : null;
}

/**
 * What digital invoicing is sent of the invoice `document`, from `seller`, issued in the shop's
 * time zone `timeZone`: its buyer the order's customer, unregistered, in the province the order
 * went to, or the seller's where that is not known; each item at what was paid for it, its tax,
 * and its share of the discount, the delivery charge as an item too. Facts of the invoice, kept
 * as it was issued; the sandbox's scenario and the shop's HS code go as it reports it.
 */
export function diInvoiceBody(
  document: FiscalDocument,
  seller: DiSeller,
  timeZone: string,
): DiInvoiceBody {
  return diWithSeller(
    {
      invoiceType: INVOICE_TYPE,
      invoiceDate: fbrDateTime(document.issuedAt, timeZone).slice(0, 10),
      sellerNTNCNIC: '',
      sellerBusinessName: '',
      sellerProvince: '',
      sellerAddress: document.sellerAddress ?? '',
      buyerNTNCNIC: '',
      buyerBusinessName: document.buyer?.name || UNNAMED_BUYER,
      buyerProvince: diProvinceOf(document.buyer?.province) ?? '',
      buyerAddress: document.buyer?.address ?? '',
      buyerRegistrationType: BUYER_REGISTRATION,
      invoiceRefNo: '',
      items: document.items.map((item) => ({
        ...(item.pctCode && { hsCode: diHsCodeOf(item.pctCode) }),
        productDescription: item.name,
        rate: diRateOf(item.rate),
        uoM: item.unit || UNIT,
        quantity: item.quantity,
        totalValues: rupees(item.total),
        valueSalesExcludingST: rupees(item.total - item.tax),
        fixedNotifiedValueOrRetailPrice: 0,
        salesTaxApplicable: rupees(item.tax),
        salesTaxWithheldAtSource: 0,
        extraTax: '',
        furtherTax: 0,
        sroScheduleNo: item.sroScheduleNo ?? '',
        fedPayable: 0,
        discount: rupees(item.discount),
        saleType:
          item.rate === null
            ? SALE_TYPES.untaxed
            : item.sroScheduleNo
              ? SALE_TYPES.reduced
              : SALE_TYPES.taxed,
        sroItemSerialNo: item.sroItemSerialNo ?? '',
      })),
    },
    seller,
  );
}

/**
 * `body` from `seller` as it is now, for one sent again once the shop put right what FBR refused:
 * where the invoice names no place of its own, the seller's province stands for it.
 */
export function diWithSeller(body: DiInvoiceBody, seller: DiSeller): DiInvoiceBody {
  const province = seller.province ? DI_PROVINCES[seller.province] : '';
  const buyerProvince = body.buyerProvince || province;
  return {
    ...body,
    sellerNTNCNIC: seller.ntn ? diNtnOf(seller.ntn) : '',
    sellerBusinessName: seller.businessName,
    sellerProvince: province,
    sellerAddress: body.sellerAddress || province,
    buyerProvince,
    buyerAddress: body.buyerAddress || buyerProvince,
  };
}

/**
 * `body` as the shop reports it in `environment`: the sandbox's scenario there alone, and its
 * items without codes of their own under `pctCode`.
 */
export function diInvoiceRequest(
  body: DiInvoiceBody,
  environment: FbrEnvironment,
  pctCode: string,
): DiInvoiceRequest {
  return {
    ...body,
    ...(environment === 'sandbox' && { scenarioId: DI_SANDBOX_SCENARIO }),
    items: body.items.map((item) => ({ ...item, hsCode: item.hsCode ?? diHsCodeOf(pctCode) })),
  };
}
