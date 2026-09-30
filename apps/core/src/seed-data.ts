import type { CreateCollectionInput, CreateProductInput } from '@hatti/catalog/public';
import type {
  BlocklistAddInput,
  MarketingConsentInput,
  SegmentCreateInput,
} from '@hatti/customers/public';
import type { LocationAddInput } from '@hatti/inventory/public';
import type {
  DraftOrderInput,
  OrderCreateInput,
  RefundInput,
  TrackingInput,
} from '@hatti/orders/public';

/** A small, realistic Pakistani catalogue for local development and demos. */
export const SAMPLE_PRODUCTS: CreateProductInput[] = [
  {
    title: 'Lawn 3-Piece Suit (Unstitched)',
    status: 'active',
    vendor: 'Bazaar Textiles',
    productType: 'Unstitched',
    tags: ['lawn', 'summer', 'women'],
    description: 'Printed lawn shirt, dyed trouser and chiffon dupatta.',
    variants: [{ price: '4,990', compareAtPrice: '6,500', sku: 'LAWN-3PC-01' }],
  },
  {
    title: 'Peshawari Chappal',
    status: 'active',
    vendor: 'Qissa Khwani Footwear',
    productType: 'Footwear',
    tags: ['chappal', 'men', 'leather'],
    options: [{ name: 'Size', values: ['8', '9', '10'] }],
    variants: [
      { optionValues: ['8'], price: '3,499', cost: '1,950', sku: 'PC-08', weightGrams: 900 },
      { optionValues: ['9'], price: '3,499', cost: '1,950', sku: 'PC-09', weightGrams: 950 },
      { optionValues: ['10'], price: '3,699', cost: '2,050', sku: 'PC-10', weightGrams: 1000 },
    ],
  },
  {
    title: 'Multani Khussa',
    status: 'active',
    vendor: 'Multan Craft House',
    productType: 'Footwear',
    tags: ['khussa', 'wedding', 'women'],
    options: [
      { name: 'Size', values: ['37', '38'] },
      { name: 'Colour', values: ['Gold', 'Silver'] },
    ],
    variants: [
      { optionValues: ['37', 'Gold'], price: '2,250' },
      { optionValues: ['38', 'Gold'], price: '2,250' },
      { optionValues: ['38', 'Silver'], price: '2,350' },
    ],
  },
  {
    title: 'Shalwar Qameez, Wash & Wear',
    status: 'active',
    vendor: 'Bazaar Textiles',
    productType: 'Stitched',
    tags: ['men', 'eid', 'کرتا شلوار'],
    options: [{ name: 'Size', values: ['M', 'L', 'XL'] }],
    variants: [
      { optionValues: ['M'], price: '3,200' },
      { optionValues: ['L'], price: '3,200' },
      { optionValues: ['XL'], price: '3,400' },
    ],
  },
  {
    title: 'Sindhi Ajrak',
    status: 'active',
    vendor: 'Hala Block Prints',
    productType: 'Accessories',
    tags: ['ajrak', 'sindh', 'gift'],
    variants: [{ price: '1,850' }],
  },
  {
    title: 'Kashmiri Pashmina Shawl',
    status: 'draft',
    vendor: 'Neelum Looms',
    productType: 'Accessories',
    tags: ['shawl', 'winter'],
    variants: [{ price: '12,500', compareAtPrice: '15,000' }],
  },
];

/** Smart collections over the sample catalogue; they fill themselves from the rules. */
export const SAMPLE_COLLECTIONS: CreateCollectionInput[] = [
  {
    title: 'Footwear',
    sortOrder: 'price_asc',
    ruleSet: {
      appliedDisjunctively: false,
      rules: [{ column: 'type', relation: 'equals', condition: 'Footwear' }],
    },
  },
  {
    title: 'Eid Edit',
    ruleSet: {
      appliedDisjunctively: true,
      rules: [
        { column: 'tag', relation: 'equals', condition: 'eid' },
        { column: 'tag', relation: 'equals', condition: 'wedding' },
      ],
    },
  },
];

/** A warehouse that ships online orders, and a shop that sells only over the counter. */
export const SAMPLE_LOCATIONS: LocationAddInput[] = [
  {
    name: 'Lahore warehouse',
    address: {
      address1: 'Plot 14, Sundar Industrial Estate',
      city: 'Lahore',
      zip: '53700',
      phone: '0300 1234567',
    },
  },
  {
    name: 'Karachi store',
    address: { address1: 'Shop 7, Tariq Road', city: 'Karachi', zip: '75400' },
    fulfillsOnlineOrders: false,
  },
];

/**
 * Stock counts: product, then variant title, then units at each location. Products left out are
 * not tracked: the ajrak is block-printed to order.
 */
export const SAMPLE_STOCK: Record<string, Record<string, Record<string, number>>> = {
  'Lawn 3-Piece Suit (Unstitched)': {
    'Default Title': { 'Lahore warehouse': 25, 'Karachi store': 5 },
  },
  'Peshawari Chappal': {
    '8': { 'Lahore warehouse': 6 },
    '9': { 'Lahore warehouse': 0 },
    '10': { 'Lahore warehouse': 3, 'Karachi store': 2 },
  },
  'Multani Khussa': {
    '37 / Gold': { 'Lahore warehouse': 4 },
    '38 / Gold': { 'Lahore warehouse': 2 },
    '38 / Silver': { 'Karachi store': 1 },
  },
  'Shalwar Qameez, Wash & Wear': {
    M: { 'Lahore warehouse': 10 },
    L: { 'Lahore warehouse': 12 },
    XL: { 'Lahore warehouse': 4 },
  },
  'Kashmiri Pashmina Shawl': {
    'Default Title': { 'Karachi store': 2 },
  },
};

/** What happens to a sample order after it is placed; `link` makes one for its customer. */
export type SampleStep =
  | 'link'
  | 'confirm'
  | 'pack'
  | 'cancel'
  | 'ship'
  | 'deliver'
  | 'pay'
  | 'refund'
  | 'refuse'
  | 'check_in';

/** An order of sample products, by product title and variant title, and what happens next. */
export interface SampleOrder extends Omit<OrderCreateInput, 'lineItems'> {
  lines: { product: string; variant: string; quantity: number }[];
  then?: SampleStep[];
  /** The courier, once it ships. */
  tracking?: TrackingInput;
  /** Products written off when a refused parcel is checked back in; the rest are restocked. */
  writtenOff?: string[];
  /** Money given back, at the refund step. */
  refund?: RefundInput;
}

/** Numbers on the blocklist before the sample orders come in. */
export const SAMPLE_BLOCKLIST: BlocklistAddInput[] = [
  {
    phone: '0300 0000786',
    reason: 'fake_orders',
    note: 'Prank orders; the number was shared in a WhatsApp group of sellers',
  },
  { phone: '0311 2223344', reason: 'refused_deliveries', note: 'Refused two parcels in August' },
];

/**
 * Orders at every stage: waiting to be confirmed (the first with a link for its customer), to
 * pack, to book, prepaid, cancelled, in transit,
 * delivered and paid (with its delivery charge refunded), and refused at the door and checked back
 * in. One customer comes back for
 * more, and a blocked number's order waits for review. So does the next order of the customer who
 * refused a parcel: a large one, to a vaguer address, it scores high risk. The last one comes from
 * a customer's second SIM, and is merged into her profile (see SAMPLE_MERGES).
 */
export const SAMPLE_ORDERS: SampleOrder[] = [
  {
    lines: [
      { product: 'Peshawari Chappal', variant: '8', quantity: 1 },
      { product: 'Sindhi Ajrak', variant: 'Default Title', quantity: 1 },
    ],
    shippingAddress: {
      name: 'Ayesha Khan',
      phone: '0300 1234567',
      address1: 'House 12, Street 4, Block 5, Gulshan-e-Iqbal',
      address2: 'Near Nipa Chowrangi',
      city: 'Karachi',
      zip: '75300',
    },
    shippingPrice: '250',
    note: 'Customer asked for delivery after 5 pm',
    then: ['link'],
  },
  {
    lines: [{ product: 'Lawn 3-Piece Suit (Unstitched)', variant: 'Default Title', quantity: 2 }],
    shippingAddress: {
      name: 'Fatima Raza',
      phone: '0321 7654321',
      address1: 'Flat 3, Al-Rehman Plaza, G-11 Markaz',
      city: 'Islamabad',
      zip: '44000',
    },
    shippingPrice: '250',
    then: ['confirm', 'pack'],
  },
  {
    lines: [{ product: 'Shalwar Qameez, Wash & Wear', variant: 'L', quantity: 1 }],
    shippingAddress: {
      name: 'Bilal Ahmed',
      phone: '0333 5551234',
      address1: '45-B, Model Town',
      city: 'Lahore',
    },
    paymentMethod: 'prepaid',
    tags: ['bank transfer'],
  },
  {
    lines: [{ product: 'Multani Khussa', variant: '37 / Gold', quantity: 1 }],
    shippingAddress: {
      name: 'Sana Tariq',
      phone: '0345 9876543',
      address1: 'Mohalla Qadirabad, Street 2',
      city: 'Multan',
    },
    then: ['cancel'],
  },
  {
    lines: [{ product: 'Shalwar Qameez, Wash & Wear', variant: 'M', quantity: 2 }],
    shippingAddress: {
      name: 'Hira Baig',
      phone: '0301 2345678',
      address1: 'House 88, Street 3, Peoples Colony',
      city: 'Faisalabad',
    },
    shippingPrice: '250',
    then: ['confirm', 'ship'],
    tracking: { company: 'Leopards', number: 'LE4402917' },
  },
  {
    lines: [{ product: 'Peshawari Chappal', variant: '10', quantity: 1 }],
    shippingAddress: {
      name: 'Usman Ali',
      phone: '0312 3456789',
      address1: 'Mohallah Jangi, Qissa Khwani',
      city: 'Peshawar',
    },
    shippingPrice: '300',
    then: ['confirm', 'ship', 'deliver', 'pay', 'refund'],
    tracking: { company: 'TCS', number: '779012345678' },
    refund: {
      amount: '300',
      method: 'mobile_wallet',
      reference: 'JC-7781204',
      note: 'Delivered three days late: delivery charge returned',
    },
  },
  {
    lines: [
      { product: 'Multani Khussa', variant: '38 / Gold', quantity: 1 },
      { product: 'Shalwar Qameez, Wash & Wear', variant: 'XL', quantity: 1 },
    ],
    shippingAddress: {
      name: 'Zainab Hussain',
      phone: '0322 4567890',
      address1: 'Flat 5, Latifabad Unit 7',
      city: 'Hyderabad',
    },
    shippingPrice: '250',
    then: ['confirm', 'ship', 'refuse', 'check_in'],
    tracking: { company: 'PostEx', number: 'PX10293847' },
    writtenOff: ['Shalwar Qameez, Wash & Wear'],
  },
  {
    lines: [{ product: 'Lawn 3-Piece Suit (Unstitched)', variant: 'Default Title', quantity: 1 }],
    shippingAddress: {
      name: 'Ayesha Khan',
      phone: '0300-1234567',
      address1: 'House 12, Street 4, Block 5, Gulshan-e-Iqbal',
      address2: 'Near Nipa Chowrangi',
      city: 'Karachi',
      zip: '75300',
    },
    email: 'ayesha.khan@example.com',
    shippingPrice: '250',
    then: ['confirm'],
  },
  {
    lines: [{ product: 'Sindhi Ajrak', variant: 'Default Title', quantity: 3 }],
    shippingAddress: {
      name: 'Kamran',
      phone: '0300 0000786',
      address1: 'Near Clock Tower',
      city: 'Sukkur',
    },
  },
  {
    lines: [{ product: 'Lawn 3-Piece Suit (Unstitched)', variant: 'Default Title', quantity: 3 }],
    shippingAddress: {
      name: 'Zainab Hussain',
      phone: '0322 4567890',
      address1: 'Near the bus stop, Latifabad',
      city: 'Hyderabad',
    },
    shippingPrice: '250',
  },
  {
    lines: [{ product: 'Sindhi Ajrak', variant: 'Default Title', quantity: 1 }],
    shippingAddress: {
      name: 'Ayesha K.',
      phone: '0311 7654320',
      address1: 'House 12, Street 4, Block 5, Gulshan-e-Iqbal',
      city: 'Karachi',
      zip: '75300',
    },
    shippingPrice: '250',
  },
];

/** What happens to a sample draft order: a link is sent, the customer confirms it, staff place it. */
export type SampleDraftStep = 'link' | 'confirm' | 'complete';

/** A draft order of sample products, at prices agreed in a chat, and what happens next. */
export interface SampleDraft extends Omit<DraftOrderInput, 'lineItems'> {
  lines: { product: string; variant: string; quantity: number; price?: string }[];
  then?: SampleDraftStep[];
}

/**
 * Orders being taken in chats, after the sample orders: one sent to the customer before their
 * address, for them to add it; one sent to them to confirm; one they confirmed through its link;
 * and one staff placed once a bank transfer came in.
 */
export const SAMPLE_DRAFTS: SampleDraft[] = [
  {
    lines: [{ product: 'Multani Khussa', variant: '38 / Gold', quantity: 1, price: '2,100' }],
    source: 'instagram',
    note: 'Asked whether the gold comes in size 39',
    // Sent before the address: the customer adds it on the link's page.
    then: ['link'],
  },
  {
    lines: [
      {
        product: 'Lawn 3-Piece Suit (Unstitched)',
        variant: 'Default Title',
        quantity: 1,
        price: '4,500',
      },
      { product: 'Sindhi Ajrak', variant: 'Default Title', quantity: 1 },
    ],
    source: 'whatsapp',
    shippingAddress: {
      name: 'Mehwish Anwar',
      phone: '0302 1112233',
      address1: 'House 7, Street 11, F-10/2',
      city: 'Islamabad',
      zip: '44000',
    },
    shippingPrice: '200',
    then: ['link'],
  },
  {
    lines: [{ product: 'Peshawari Chappal', variant: '8', quantity: 1 }],
    source: 'whatsapp',
    shippingAddress: {
      name: 'Adeel Qureshi',
      phone: '0346 5558899',
      address1: 'Shop 3, Saddar Bazaar',
      city: 'Rawalpindi',
    },
    shippingPrice: '250',
    then: ['link', 'confirm'],
  },
  {
    lines: [{ product: 'Shalwar Qameez, Wash & Wear', variant: 'L', quantity: 2, price: '3,000' }],
    source: 'facebook',
    paymentMethod: 'prepaid',
    shippingAddress: {
      name: 'Nadia Iqbal',
      phone: '0315 2223344',
      address1: 'House 21, Canal View',
      city: 'Lahore',
    },
    tags: ['bank transfer'],
    then: ['complete'],
  },
];

/** Duplicates to merge once the orders are in, by number: the customer kept, then the other. */
export const SAMPLE_MERGES: { keep: string; duplicate: string }[] = [
  { keep: '0300 1234567', duplicate: '0311 7654320' },
];

/** Saved customer filters over the sample orders. */
export const SAMPLE_SEGMENTS: SegmentCreateInput[] = [
  { name: 'Repeat buyers', query: 'number_of_orders >= 2' },
  { name: 'Refused a parcel', query: 'returned_orders >= 1' },
  { name: 'Punjab, never refused', query: 'province = Punjab AND returned_orders = 0' },
  { name: 'Karachi and Lahore', query: 'city IN (khi, lhr) AND blocked = false' },
  { name: 'WhatsApp subscribers', query: 'whatsapp_subscription_status = subscribed' },
];

const WHATSAPP_WORDING = 'Send me offers and new arrivals on WhatsApp';

/** What some sample customers said about marketing, by mobile number. */
export const SAMPLE_CONSENT: { phone: string; consent: MarketingConsentInput[] }[] = [
  {
    phone: '0300 1234567',
    consent: [{ channel: 'whatsapp', state: 'subscribed', wording: WHATSAPP_WORDING }],
  },
  {
    phone: '0312 3456789',
    consent: [
      { channel: 'whatsapp', state: 'subscribed', wording: WHATSAPP_WORDING },
      { channel: 'sms', state: 'subscribed', wording: 'Send me offers by SMS' },
    ],
  },
  {
    phone: '0301 2345678',
    consent: [{ channel: 'whatsapp', state: 'unsubscribed', wording: 'STOP' }],
  },
];
