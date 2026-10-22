// Hatti's own legal documents (ADR-736): what a shop agrees to with Hatti, and what Hatti tells
// the people whose data it keeps. Each is versioned by the day it takes effect, so that an
// agreement records exactly what was agreed to. The English text is what binds; each carries its
// gist in Urdu. They state what the platform does as built: a change to that changes the text,
// under a new version.
//
// They are drafts until counsel in Pakistan has reviewed them (OWN-41): a blank to be filled in is
// written [To come: ...], and none may be marked reviewed while one is left.

export type LegalHandle =
  'terms' | 'privacy' | 'acceptable-use' | 'data-processing' | 'sub-processors';

export interface LegalSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

export interface LegalDocument {
  readonly handle: LegalHandle;
  readonly title: { readonly en: string; readonly ur: string };
  /** The day this version takes effect, YYYY-MM-DD: what an agreement to it records. */
  readonly version: string;
  /** What it is, in a line, for the list of documents. */
  readonly summary: string;
  /** Its gist in Urdu, a paragraph each; the English text is what binds. */
  readonly urdu: readonly string[];
  readonly sections: readonly LegalSection[];
}

/** A service Hatti hands personal data to, to run the platform (11 §7). */
export interface SubProcessor {
  readonly name: string;
  readonly purpose: string;
  /** What personal data reaches it. */
  readonly data: string;
  readonly location: string;
  /**
   * `in_use`: the platform uses it once configured; `to_choose`: Hatti has yet to choose who
   * (OWN-03 to OWN-11), and the list names them before they receive any data.
   */
  readonly status: 'in_use' | 'to_choose';
}

/**
 * Whether counsel has reviewed these texts (OWN-41). Until then each page says it is a draft, and
 * the test refuses `true` while any blank is left.
 */
export const LEGAL_REVIEWED = false;

/** What the owner of a shop agrees to, to open it. */
export const SHOP_AGREEMENT: readonly LegalHandle[] = [
  'terms',
  'acceptable-use',
  'data-processing',
];

/** A blank in a draft, for counsel or the owner to fill in. */
export const BLANK = /\[To come: [^\]]+\]/g;

const VERSION = '2026-10-22';

export const SUB_PROCESSORS: readonly SubProcessor[] = [
  {
    name: '[To come: the cloud the first cell runs in (OWN-03)]',
    purpose: 'Hosting the platform: its servers, database, backups and logs',
    data: 'Everything the platform keeps',
    location: '[To come: the cell’s region]',
    status: 'to_choose',
  },
  {
    name: 'Cloudflare, Inc.',
    purpose:
      'Serving storefronts at the edge, storing files and images (R2), shops’ own domains and their certificates, and telling people from bots at checkout (Turnstile)',
    data: 'Shoppers’ and staff’s internet addresses and requests; files shops upload, such as product images and transfer receipts',
    location: 'Worldwide edge; storage in [To come: the bucket’s region]',
    status: 'in_use',
  },
  {
    name: 'Amazon Web Services (Amazon SES)',
    purpose:
      'Sending email: account verification, invitations, order emails, invoices and status updates',
    data: 'Email addresses and the messages sent to them',
    location: '[To come: the SES region]',
    status: 'in_use',
  },
  {
    name: 'Meta Platforms (WhatsApp Business Platform)',
    purpose:
      'Sending and receiving WhatsApp messages from Hatti’s shared number and shops’ own numbers',
    data: 'Mobile numbers, names and the messages sent and received',
    location: 'Meta’s data centres',
    status: 'in_use',
  },
  {
    name: '[To come: the SMS gateway (OWN-10)]',
    purpose:
      'Sending one-time codes, order updates where WhatsApp cannot deliver, and SMS campaigns shops send',
    data: 'Mobile numbers and the messages sent to them',
    location: 'Pakistan',
    status: 'to_choose',
  },
  {
    name: '[To come: the voice gateway (OWN-09)]',
    purpose: 'Calls in Urdu that ask customers to confirm cash-on-delivery orders',
    data: 'Mobile numbers, the order’s number and amount, and the key pressed',
    location: 'Pakistan',
    status: 'to_choose',
  },
  {
    name: '[To come: the AI provider (OWN-11)]',
    purpose: 'Drafting translations and product copy, and cropping product photos, when staff ask',
    data: 'The product’s words and photos sent with the request; no customer data',
    location: '[To come]',
    status: 'to_choose',
  },
  {
    name: '[To come: the map tile provider (OWN-06)]',
    purpose: 'The map a shopper moves to place the pin of their address',
    data: 'The shopper’s internet address and the part of the map they look at',
    location: '[To come]',
    status: 'to_choose',
  },
  {
    name: 'Safepay',
    purpose: 'Taking payment of Hatti’s own invoices to shops by card and wallet',
    data: 'The paying owner’s name, email, mobile number and the invoice’s amount',
    location: 'Pakistan',
    status: 'in_use',
  },
];

const TERMS: LegalDocument = {
  handle: 'terms',
  title: { en: 'Terms of service', ur: 'سروس کی شرائط' },
  version: VERSION,
  summary: 'The agreement between Hatti and each shop that uses it.',
  urdu: [
    'یہ ہٹی اور ہر اس دکان کے درمیان معاہدہ ہے جو ہٹی استعمال کرتی ہے۔ دکان اپنے سامان کی بیچنے والی خود ہے: گاہکوں سے سودا، ان کی پالیسیاں اور قانون کی پابندی اس کی اپنی ذمہ داری ہے۔ ہٹی کسی فروخت پر کوئی فیس نہیں لیتا؛ دکان اپنے پلان کی ماہانہ یا سالانہ قیمت ادا کرتی ہے، جس پر صوبائی سیلز ٹیکس الگ ہے۔',
    'اگر کسی مدت کی ادائیگی نہ ہو تو دکان سات دن تک اسی پلان پر رہتی ہے، پھر مفت پلان پر چلی جاتی ہے؛ اس کا ڈیٹا نہیں مٹتا۔ دکان کسی بھی وقت اپنا سارا ڈیٹا ایکسپورٹ کر سکتی ہے۔',
    'ممنوعہ اشیاء بیچنا یا گاہکوں کے ڈیٹا کا غلط استعمال منع ہے۔ کسی شکایت کے درست ثابت ہونے پر ہٹی دکان یا اس کی لسٹنگز بند کر سکتا ہے، اور دکان کا مالک وجہ جان کر اپیل کر سکتا ہے۔ ان شرائط میں بڑی تبدیلی سے تیس دن پہلے بتایا جائے گا۔',
  ],
  sections: [
    {
      heading: '1. Who we are, and these terms',
      paragraphs: [
        'Hatti is a platform for running an online shop: a storefront, a checkout, orders, couriers, payments, messages to customers and the tools around them. "Hatti", "we" and "us" mean [To come: Hatti’s legal name, its company registration number and registered address]. "You" means the business that opens a shop on Hatti, and the person who opens it on the business’s behalf, who confirms they may bind it.',
        'These terms, the Acceptable use policy and the Data processing agreement, each at the version shown when you opened your shop or as changed under section 13, are the whole agreement between you and Hatti. An enterprise agreement signed with Hatti prevails where it differs.',
      ],
    },
    {
      heading: '2. Your account and your staff',
      paragraphs: [
        'Give true details when you sign up and keep them current. Keep your password, passkeys and second factor to yourself: a shop’s owner must sign in with a second factor. You are responsible for what is done in your shop by its staff, collaborators and the apps you install or make, within the permissions you give them.',
        'You must be old enough to make a binding contract under Pakistani law, and use Hatti for your business, not as a consumer.',
      ],
    },
    {
      heading: '3. Your shop and what you sell',
      paragraphs: [
        'You are the seller. Each sale is a contract between you and your customer, under the policies you publish; Hatti is not a party to it, does not sell your goods and does not hold the money your customers pay you.',
        'You are responsible for your goods, prices, descriptions, delivery, returns and refunds, and for following the law that applies to them, consumer protection and tax included. Hatti’s tools help, for example by drafting policies and printing invoices with your tax registration, but do not make your shop compliant on your behalf.',
        'Pakistani law limits cash collected on delivery; checkout does not take an order that would collect more than Rs 200,000 in cash, whatever the shop’s settings.',
      ],
    },
    {
      heading: '4. Plans, billing and taxes',
      paragraphs: [
        'Your plan’s price is shown when you choose it, in rupees and before provincial sales tax on services, which is added to each invoice. Hatti charges no fee on your sales on any plan.',
        'Plans are paid in advance for a month or a year. The renewal invoice is made seven days before the period ends. A period left unpaid keeps your plan for seven days after it ends, with reminders, and then your shop moves to the Free plan and its limits; nothing is deleted, and paying returns it to the plan.',
        'An annual plan cancelled within 30 days of payment is refunded for the months not used. Message credit and AI credit are bought in advance and used as messages are sent and drafts are made; [To come: whether unused credit is refunded when a shop closes].',
      ],
    },
    {
      heading: '5. Payments, couriers and other services you connect',
      paragraphs: [
        'Payment gateways, couriers, your own WhatsApp number, advertising platforms and other services you connect to your shop are yours: you contract with them, and their terms apply between you. Hatti passes them what your settings and actions ask it to, as your processor, and is not responsible for what they do.',
        'Couriers remit cash collected on delivery to you directly, and gateways settle online payments to you directly; Hatti helps you reconcile what they report.',
      ],
    },
    {
      heading: '6. Messages to your customers',
      paragraphs: [
        'Hatti sends your customers the messages your shop’s settings ask for, from Hatti’s shared WhatsApp number or SMS sender, or from your own number once connected. Send marketing only to customers who agreed to it; Hatti records each customer’s consent and stops every message to a number that asks it to stop, in English, Urdu or Roman Urdu.',
        'WhatsApp’s and the mobile networks’ own rules apply to every message, and a number they restrict for complaints may stop sending.',
      ],
    },
    {
      heading: '7. Content and intellectual property',
      paragraphs: [
        'What you put in your shop stays yours. You give Hatti a licence to host, copy, show, translate where you ask, and send it, as far as running your shop needs, for as long as it is on Hatti. You confirm you have the rights to what you upload.',
        'Hatti’s software, themes and brand remain Hatti’s. You may use and change Hatti’s themes for your shop on Hatti.',
      ],
    },
    {
      heading: '8. Acceptable use, reports and takedowns',
      paragraphs: [
        'The Acceptable use policy is part of these terms. A product whose words name goods it forbids stays a draft until its words change or Hatti’s people clear it.',
        'Anyone may report a shop from any storefront’s footer, and rights owners may complain of a listing; Hatti’s people decide within 48 hours. When a report is upheld, Hatti may take the listings off sale, or suspend the storefront and checkout, and tells the shop’s owner why. The owner may appeal, or answer a rights complaint, through the link in that notice, and Hatti’s people decide again with reasons.',
      ],
    },
    {
      heading: '9. Data',
      paragraphs: [
        'The Privacy policy says what Hatti does with the data of shop owners and staff. For your customers’ personal data you are the controller and Hatti your processor, under the Data processing agreement.',
        'You may export your whole shop, products, customers, orders and content, at any time from the admin.',
      ],
    },
    {
      heading: '10. Availability and changes to Hatti',
      paragraphs: [
        'Hatti aims to keep storefronts and checkout working 99.95% of each month and reports how it does on its public status page, where maintenance is announced ahead. These aims are not a guarantee, unless an enterprise agreement says otherwise.',
        'Hatti improves and changes its features. One you rely on is not removed without 30 days’ notice, unless the law, a partner or security requires it sooner.',
      ],
    },
    {
      heading: '11. Closing a shop',
      paragraphs: [
        'You may close your shop at any time by asking Hatti’s support; [To come: closing a shop from the admin]. Hatti may close a shop that breaks these terms seriously or repeatedly, after notice and a chance to put it right, except where the law or harm to others requires acting at once.',
        'A closed shop’s data stays 90 days, for you to export, and is then deleted, except records the law requires Hatti to keep, such as tax records, which are kept for six years.',
      ],
    },
    {
      heading: '12. Liability',
      paragraphs: [
        'Hatti is provided with reasonable skill and care. Neither of us is liable to the other for lost profits or indirect losses. Hatti’s total liability to you in any twelve months is limited to what you paid Hatti in those months. Nothing limits liability that the law does not allow to be limited. [To come: counsel’s review of this section and of an indemnity for claims from goods you sell].',
      ],
    },
    {
      heading: '13. Changes to these terms',
      paragraphs: [
        'Each version of these terms is dated. Hatti tells shops’ owners of a change that matters by email and in the admin 30 days before it takes effect; continuing to use Hatti after that is agreement to it, and a shop that does not agree may close without charge for the remaining period.',
      ],
    },
    {
      heading: '14. Law and disputes',
      paragraphs: [
        'These terms are governed by the laws of Pakistan. Tell Hatti’s support of a dispute first; one not settled within 30 days goes to the courts of [To come: the city counsel advises].',
      ],
    },
  ],
};

const PRIVACY: LegalDocument = {
  handle: 'privacy',
  title: { en: 'Privacy policy', ur: 'پرائیویسی پالیسی' },
  version: VERSION,
  summary:
    'What Hatti keeps about shop owners, their staff and visitors to its own pages, and why.',
  urdu: [
    'یہ پالیسی بتاتی ہے کہ ہٹی دکان کے مالکان، ان کے عملے اور ہٹی کے اپنے صفحات پر آنے والوں کے بارے میں کیا معلومات رکھتا ہے اور کیوں: اکاؤنٹ چلانے، حفاظت، بلنگ اور قانونی تقاضوں کے لیے۔ ہٹی آپ کا ڈیٹا بیچتا نہیں۔',
    'اگر آپ نے ہٹی پر کسی دکان سے خریداری کی ہے تو آپ کے ڈیٹا کی ذمہ دار وہ دکان ہے؛ اپنا ڈیٹا دیکھنے یا مٹانے کے لیے دکان سے، یا اس کی ویب سائٹ پر اپنے اکاؤنٹ سے رابطہ کریں۔',
    'شناختی کارڈ، این ٹی این اور پاس ورڈ جیسی حساس معلومات خفیہ (encrypted) رکھی جاتی ہیں۔ آپ اپنی معلومات دیکھنے، درست کرنے یا مٹانے کا کہہ سکتے ہیں، سوائے اس کے جو قانون رکھنے کا تقاضا کرے۔',
  ],
  sections: [
    {
      heading: '1. Who this covers',
      paragraphs: [
        'This policy covers the people Hatti keeps data about for its own purposes: owners and staff of shops on Hatti, partners, people who write to Hatti’s support, and visitors to Hatti’s own pages, such as its status page. For these, Hatti is the controller: [To come: Hatti’s legal name and registered address].',
        'If you bought from a shop on Hatti, that shop decides what is done with your data and Hatti processes it on the shop’s behalf. Ask the shop, or use the account on its storefront, to see your data or have it erased; Hatti helps shops answer.',
      ],
    },
    {
      heading: '2. What Hatti keeps',
      paragraphs: [
        'Your account: your name, mobile number, email, language, a hash of your password, your passkeys’ public keys and your second factor’s secret, encrypted.',
        'Your sign-ins: when, from which internet address and on which device, to keep accounts safe and to warn you of a sign-in you may not have made.',
        'Your shop and its billing: its business details, the plan and invoices, and payments made to Hatti. For verification, the CNIC and NTN you give, encrypted, and the documents you upload.',
        'What you tell Hatti: support requests, by the admin, email or WhatsApp, and status updates you subscribe to.',
        'What you do in the admin is recorded in your shop’s activity log and in Hatti’s audit log, with who did it and when.',
      ],
    },
    {
      heading: '3. Why',
      paragraphs: [
        'To provide the service you signed up for, under the Terms of service; to keep accounts and shops secure and to prevent fraud and abuse, which is Hatti’s legitimate interest; to bill you and keep tax records, as the law requires; and to tell you what you need to know of your account, shop and the service.',
        'Hatti does not sell personal data, and does not use your shop’s customers’ data for its own purposes.',
      ],
    },
    {
      heading: '4. Who it is shared with',
      paragraphs: [
        'The services Hatti uses to run the platform, each listed on the Sub-processors page, receive what their part needs. Authorities receive data when Pakistani law requires it. A buyer of Hatti’s business would receive it under this policy.',
      ],
    },
    {
      heading: '5. Where it is kept, and for how long',
      paragraphs: [
        'Hatti’s data is kept in [To come: the cell’s country and region (OWN-03)]. Your account is kept while you use it. Tax and billing records are kept six years. Backups roll over: each day’s for 35 days and each month’s for twelve months. Messages are kept twelve months.',
      ],
    },
    {
      heading: '6. Your rights',
      paragraphs: [
        'You may ask to see the data Hatti keeps about you, to correct it, to have it erased, or to object to its use, by writing to [To come: the privacy contact]. Hatti answers within 30 days. Records the law requires are kept even if you ask for erasure.',
      ],
    },
    {
      heading: '7. Security',
      paragraphs: [
        'Data is encrypted in transit and at rest; credentials, CNICs and other secrets are encrypted again, field by field. Each shop’s data is kept apart in the database. Staff of Hatti see a shop’s data only with its owner’s consent, for the time the owner allows, and every look is logged.',
      ],
    },
    {
      heading: '8. Cookies',
      paragraphs: [
        'Hatti’s admin keeps your session in your browser to keep you signed in, and nothing for advertising. Storefronts belong to their shops, whose own pixels run only as each shop sets them, and, where a shop asks, only after the shopper agrees.',
      ],
    },
    {
      heading: '9. Changes',
      paragraphs: [
        'Each version of this policy is dated. A change that matters is told to account holders by email before it takes effect.',
      ],
    },
  ],
};

const ACCEPTABLE_USE: LegalDocument = {
  handle: 'acceptable-use',
  title: { en: 'Acceptable use policy', ur: 'قابلِ قبول استعمال کی پالیسی' },
  version: VERSION,
  summary: 'What may not be sold or done on Hatti, and how Hatti acts on it.',
  urdu: [
    'ہٹی پر اسلحہ، منشیات، شراب، بغیر لائسنس دوائیں، جعلی یا "ریپلیکا" برانڈڈ اشیاء، محفوظ جنگلی حیات اور جوا بیچنا منع ہے۔ ایسی اشیاء کا ذکر کرنے والی پروڈکٹ ڈرافٹ ہی رہتی ہے جب تک اس کے الفاظ نہ بدلیں یا ہٹی کی ٹیم اسے کلیئر نہ کرے۔',
    'جعلی آرڈر، دھوکہ دہی، گاہکوں کو بغیر اجازت مارکیٹنگ پیغامات، گاہکوں کے ڈیٹا کا غلط استعمال اور پیکا (PECA) کے تحت غیر قانونی مواد بھی منع ہے۔',
    'کوئی بھی کسی دکان کی شکایت کر سکتا ہے؛ ہٹی کی ٹیم 48 گھنٹوں میں فیصلہ کرتی ہے۔ شکایت درست ہونے پر لسٹنگز یا دکان بند کی جا سکتی ہے، اور مالک وجہ جان کر اپیل کر سکتا ہے۔',
  ],
  sections: [
    {
      heading: '1. Goods that may not be sold',
      paragraphs: [
        'Weapons, ammunition and explosives, and parts to make them; narcotics and controlled substances; alcohol; medicines that need a prescription or a licence to sell; counterfeit goods, and "replica" or "first copy" goods sold under another’s brand; protected wildlife and goods made from it; gambling and lotteries.',
        '[To come: goods that may be sold only with a licence, and what proof Hatti asks for, as counsel advises].',
      ],
    },
    {
      heading: '2. What may not be done',
      paragraphs: [
        'Defrauding customers or Hatti, placing false orders, or selling what you do not mean to deliver.',
        'Sending marketing to people who did not agree to it, or continuing after they ask to stop; using customers’ data for anything but your shop’s dealings with them; selling or sharing it.',
        'Publishing content that Pakistani law forbids, including under the Prevention of Electronic Crimes Act; content that sexualises children; harassment, or content inciting hatred or violence.',
        'Infringing others’ trademarks, copyright or other rights.',
        'Attacking, probing or overloading Hatti, getting round its limits, or reaching other shops’ data.',
      ],
    },
    {
      heading: '3. How Hatti acts',
      paragraphs: [
        'A product whose words name forbidden goods stays a draft, never on sale, until its words change or Hatti’s people clear it.',
        'Anyone may report a shop from the link in every storefront’s footer; rights owners may complain of listings from a shop’s rights page, swearing to their complaint. Hatti’s people decide within 48 hours.',
        'A report upheld may take listings off sale, or suspend the storefront and checkout, and the shop’s owner is told why. The owner may appeal, or answer a rights complaint once, through the notice’s link; Hatti’s people refuse with reasons or restore what was taken down. Where the law requires, Hatti reports to the authorities.',
      ],
    },
  ],
};

const DATA_PROCESSING: LegalDocument = {
  handle: 'data-processing',
  title: { en: 'Data processing agreement', ur: 'ڈیٹا پراسیسنگ کا معاہدہ' },
  version: VERSION,
  summary: 'How Hatti processes a shop’s customers’ personal data on the shop’s behalf.',
  urdu: [
    'دکان کے گاہکوں کے ڈیٹا کی ذمہ دار (controller) دکان ہے اور ہٹی اس کی طرف سے اسے پراسیس کرتا ہے۔ ہٹی یہ ڈیٹا صرف دکان کی ہدایت پر استعمال کرتا ہے، یعنی جو دکان ایڈمن، سیٹنگز یا API کے ذریعے کہے۔',
    'ہٹی ڈیٹا کی حفاظت کرتا ہے، اپنے ذیلی پراسیسرز کی فہرست شائع کرتا ہے اور نئے کے بارے میں تیس دن پہلے بتاتا ہے، گاہکوں کا ڈیٹا ایکسپورٹ کرنے یا مٹانے کے آلات دیتا ہے، اور ڈیٹا کی کسی خلاف ورزی کی صورت میں فوراً بتاتا ہے۔',
    'دکان کی بند ہونے کے نوے دن بعد اس کا ڈیٹا مٹا دیا جاتا ہے، سوائے اس کے جو قانون رکھنے کا تقاضا کرے۔',
  ],
  sections: [
    {
      heading: '1. Roles and scope',
      paragraphs: [
        'For the personal data of your shop’s customers and visitors, you are the controller and Hatti your processor. This agreement is part of the Terms of service and applies for as long as Hatti processes that data.',
        'The data: customers’ names, mobile numbers, emails and addresses, their orders, drafts, returns and payments’ records, the messages sent them and their replies, their consent records, their accounts on your storefront, and the visits that brought them. Its subjects: your customers and the visitors to your storefront.',
      ],
    },
    {
      heading: '2. Your instructions',
      paragraphs: [
        'Hatti processes the data only to provide the service, as your use of the admin, your settings and the apps and API calls you authorise instruct it, and as the law requires, in which case Hatti tells you unless the law forbids it.',
      ],
    },
    {
      heading: '3. Hatti’s people and security',
      paragraphs: [
        'Those at Hatti who can reach the data are bound to confidentiality, and reach a shop’s data only with its owner’s consent, for the time the owner allows, each look logged.',
        'Hatti keeps the data encrypted in transit and at rest, each shop’s apart from others’ in the database, with secrets encrypted again field by field, access controlled by each staff member’s permissions, and numbers masked from those who need not see them.',
      ],
    },
    {
      heading: '4. Sub-processors',
      paragraphs: [
        'You authorise the sub-processors listed on Hatti’s Sub-processors page. Hatti tells shops’ owners of a new one by email 30 days before it receives data; a shop that objects may close without charge for the remaining period. Hatti binds each to protections no weaker than these and answers for them.',
        'The services you connect yourself, such as payment gateways, couriers, your own WhatsApp number, pixels and conversion APIs, are your own choices and not Hatti’s sub-processors: Hatti sends them data because you instruct it to.',
      ],
    },
    {
      heading: '5. Helping you',
      paragraphs: [
        'The admin and the API let you export a customer’s data as a file, and erase a customer, keeping only what accounts and the law need. Your customers may ask for their file or their erasure from their account on your storefront. Hatti helps with other requests and with assessments you must make, as far as its part allows.',
      ],
    },
    {
      heading: '6. Breaches',
      paragraphs: [
        'Hatti tells you of a breach of your customers’ personal data without undue delay, and within 72 hours of becoming aware of it, with what is known, what it is doing, and updates as it learns more.',
      ],
    },
    {
      heading: '7. When the service ends',
      paragraphs: [
        'After your shop closes, its data stays 90 days for you to export, then is deleted, from backups as they roll over, except records the law requires Hatti to keep, such as tax records for six years.',
      ],
    },
    {
      heading: '8. Audits, and where data is kept',
      paragraphs: [
        'Hatti answers your reasonable questions about its compliance with this agreement, and [To come: how often a shop may audit, and at whose cost]. The data is kept in [To come: the cell’s country and region (OWN-03)].',
      ],
    },
  ],
};

const SUB_PROCESSORS_PAGE: LegalDocument = {
  handle: 'sub-processors',
  title: { en: 'Sub-processors', ur: 'ذیلی پراسیسرز' },
  version: VERSION,
  summary: 'The services Hatti hands personal data to, to run the platform.',
  urdu: [
    'یہ وہ کمپنیاں ہیں جن کی خدمات ہٹی پلیٹ فارم چلانے کے لیے استعمال کرتا ہے، اور جنہیں اپنے کام کے لیے ضروری ذاتی ڈیٹا ملتا ہے۔ نئی کمپنی شامل کرنے سے تیس دن پہلے دکانوں کے مالکان کو ای میل سے بتایا جاتا ہے۔',
    'جو سروسز دکان خود جوڑتی ہے، جیسے پیمنٹ گیٹ وے، کوریئر یا اس کا اپنا واٹس ایپ نمبر، وہ اس فہرست میں نہیں: وہ دکان کا اپنا انتخاب ہیں۔',
  ],
  sections: [
    {
      heading: 'About this list',
      paragraphs: [
        'Hatti tells shops’ owners of a new sub-processor by email 30 days before it receives data. Those still to be chosen are named here before they receive any. Services a shop connects itself, such as its payment gateways, couriers, its own WhatsApp number, pixels and conversion APIs, are its own choices and not listed.',
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  TERMS,
  PRIVACY,
  ACCEPTABLE_USE,
  DATA_PROCESSING,
  SUB_PROCESSORS_PAGE,
];

/** A document by its handle, or null. */
export function legalDocument(handle: string): LegalDocument | null {
  return LEGAL_DOCUMENTS.find((document) => document.handle === handle) ?? null;
}

/** Each document's current version, as an agreement records them. */
export function legalVersions(): Record<LegalHandle, string> {
  return Object.fromEntries(
    LEGAL_DOCUMENTS.map((document) => [document.handle, document.version]),
  ) as Record<LegalHandle, string>;
}

/** The blanks left in a document, sub-processors' among them for their page. */
export function blanks(document: LegalDocument): string[] {
  const texts = [
    ...document.sections.flatMap((section) => section.paragraphs),
    ...(document.handle === 'sub-processors'
      ? SUB_PROCESSORS.flatMap((each) => [each.name, each.purpose, each.data, each.location])
      : []),
  ];
  return texts.flatMap((text) => text.match(BLANK) ?? []);
}
