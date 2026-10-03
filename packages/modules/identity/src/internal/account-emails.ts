// Hatti's own emails about accounts (ONB-01, ADR-165): a link that proves an account's email, one
// that resets its password, one that proves the email an account changes to and a notice to the
// one it had (ADR-172), and one inviting someone to work in a shop (ADR-167), in English or Urdu.
// Each link carries a token of its own; only a digest of it is kept.

import type { StaffRole } from '@hatti/api';

export const ACCOUNT_EMAIL = {
  /** How long a link proving an email works. */
  verifyHours: 24,
  /** How long a link resetting a password works, once. */
  resetMinutes: 60,
  /** How long an account waits between links of a kind. */
  resendSeconds: 60,
  /** Links of a kind an account is sent in an hour. */
  perAccountHourly: 5,
  /** How long links are kept, to look into abuse, before they go as new ones are sent. */
  keepDays: 30,
} as const;

export type AccountEmailKind = 'verify_email' | 'reset_password' | 'change_email';

/** What an email says around its link: English or Urdu. */
export type AccountEmailLanguage = 'en' | 'ur';

/** One email to one address: its subject, and its body as text and as HTML. */
export interface AccountEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends Hatti's own emails about accounts, as the host application can: through Amazon SES in
 * production, to the log in development. Never a shop's.
 */
export abstract class AccountEmailSender {
  /** Sends `email`: whether it went. */
  abstract send(email: AccountEmail): Promise<boolean>;
}

interface Words {
  subject: string;
  greeting: (name: string) => string;
  lead: string;
  button: string;
  after: string;
}

const WORDS: Record<AccountEmailKind, Record<AccountEmailLanguage, Words>> = {
  verify_email: {
    en: {
      subject: 'Confirm your email for Hatti',
      greeting: (name) => `Assalam o alaikum ${name},`,
      lead: 'Confirm this is your email, so that you can reset your password with it if you ever forget it.',
      button: 'Confirm your email',
      after: "The link works for 24 hours. If you didn't sign up for Hatti, ignore this email.",
    },
    ur: {
      subject: 'ہٹی کے لیے اپنی ای میل کی تصدیق کریں',
      greeting: (name) => `السلام علیکم ${name}،`,
      lead: 'تصدیق کریں کہ یہ آپ کی ای میل ہے، تاکہ پاس ورڈ بھول جانے پر آپ اسی سے نیا پاس ورڈ بنا سکیں۔',
      button: 'ای میل کی تصدیق کریں',
      after:
        'یہ لنک 24 گھنٹے کام کرے گا۔ اگر آپ نے ہٹی پر اکاؤنٹ نہیں بنایا تو یہ ای میل نظرانداز کر دیں۔',
    },
  },
  change_email: {
    en: {
      subject: 'Confirm your new email for Hatti',
      greeting: (name) => `Assalam o alaikum ${name},`,
      lead: 'Confirm this is the email your Hatti account should use from now on. Until you do, it keeps the one it has.',
      button: 'Confirm your new email',
      after: "The link works once, for 24 hours. If you didn't ask for it, ignore this email.",
    },
    ur: {
      subject: 'ہٹی کے لیے اپنی نئی ای میل کی تصدیق کریں',
      greeting: (name) => `السلام علیکم ${name}،`,
      lead: 'تصدیق کریں کہ آپ کا ہٹی اکاؤنٹ اب سے یہی ای میل استعمال کرے۔ تصدیق تک اکاؤنٹ کی موجودہ ای میل برقرار رہے گی۔',
      button: 'نئی ای میل کی تصدیق کریں',
      after:
        'یہ لنک 24 گھنٹے تک ایک بار کام کرے گا۔ اگر آپ نے یہ نہیں کہا تھا تو یہ ای میل نظرانداز کر دیں۔',
    },
  },
  reset_password: {
    en: {
      subject: 'Reset your Hatti password',
      greeting: (name) => `Assalam o alaikum ${name},`,
      lead: 'Someone, we hope you, asked to reset the password of your Hatti account. Choose a new one here.',
      button: 'Choose a new password',
      after:
        "The link works once, for an hour. If it wasn't you, ignore this email: your password stays as it is.",
    },
    ur: {
      subject: 'اپنا ہٹی پاس ورڈ دوبارہ بنائیں',
      greeting: (name) => `السلام علیکم ${name}،`,
      lead: 'کسی نے، امید ہے آپ ہی نے، آپ کے ہٹی اکاؤنٹ کا پاس ورڈ دوبارہ بنانے کا کہا ہے۔ نیا پاس ورڈ یہاں بنائیں۔',
      button: 'نیا پاس ورڈ بنائیں',
      after:
        'یہ لنک ایک گھنٹے تک ایک بار کام کرے گا۔ اگر یہ آپ نہیں تھے تو یہ ای میل نظرانداز کر دیں: آپ کا پاس ورڈ ویسا ہی رہے گا۔',
    },
  },
};

/** The email of `kind`, in `language`, to `name` at `to`, carrying `link`. */
export function accountEmail(
  kind: AccountEmailKind,
  input: { to: string; name: string; link: string; language: AccountEmailLanguage },
): AccountEmail {
  const words = WORDS[kind][input.language];
  return compose(
    { ...words, greeting: words.greeting(oneLine(input.name)) },
    input.to,
    input.link,
    input.language,
  );
}

/**
 * The notice to the email an account had (ADR-172): it changed to `email`, with a link to Hatti's
 * admin, and what to do if its owner did not change it.
 */
export function emailChangedEmail(input: {
  to: string;
  name: string;
  email: string;
  link: string;
  language: AccountEmailLanguage;
}): AccountEmail {
  const name = oneLine(input.name);
  const email = oneLine(input.email);
  const words: Omit<Words, 'greeting'> & { greeting: string } =
    input.language === 'ur'
      ? {
          subject: 'آپ کے ہٹی اکاؤنٹ کی ای میل بدل گئی ہے',
          greeting: `السلام علیکم ${name}،`,
          lead: `آپ کے ہٹی اکاؤنٹ کی ای میل اب ${email} ہے: اب سے اس کے لنک اور اطلاعات وہیں جائیں گی۔`,
          button: 'ہٹی کھولیں',
          after:
            'اگر یہ تبدیلی آپ نے نہیں کی تو فوراً ہٹی کی سپورٹ سے رابطہ کریں: ہو سکتا ہے کوئی اور آپ کا اکاؤنٹ استعمال کر رہا ہو۔',
        }
      : {
          subject: 'Your Hatti account has a new email',
          greeting: `Assalam o alaikum ${name},`,
          lead: `Your Hatti account's email is now ${email}: its links and notices go there from now on.`,
          button: 'Open Hatti',
          after:
            "If you didn't change it, contact Hatti's support at once: someone else may be using your account.",
        };
  return compose(words, input.to, input.link, input.language);
}

/** What each role is called in an invitation. */
const ROLE_NAMES: Record<StaffRole, Record<AccountEmailLanguage, string>> = {
  owner: { en: 'its owner', ur: 'مالک' },
  manager: { en: 'a manager', ur: 'مینیجر' },
  confirmation_agent: { en: 'a confirmation agent', ur: 'کنفرمیشن ایجنٹ' },
  packer: { en: 'a packer', ur: 'پیکر' },
  marketer: { en: 'a marketer', ur: 'مارکیٹر' },
  accountant: { en: 'an accountant', ur: 'اکاؤنٹنٹ' },
};

/**
 * The email inviting someone at `to` to work in `shop` in `role`, from `inviter`, carrying the
 * invitation's `link` (ADR-167).
 */
export function invitationEmail(input: {
  to: string;
  inviter: string;
  shop: string;
  role: StaffRole;
  link: string;
  language: AccountEmailLanguage;
}): AccountEmail {
  const inviter = oneLine(input.inviter);
  const shop = oneLine(input.shop);
  const role = ROLE_NAMES[input.role][input.language];
  const words: Omit<Words, 'greeting'> & { greeting: string } =
    input.language === 'ur'
      ? {
          subject: `${inviter} نے آپ کو ہٹی پر ${shop} میں بلایا ہے`,
          greeting: 'السلام علیکم،',
          lead: `${inviter} نے آپ کو ہٹی پر ${shop} میں بطور ${role} کام کرنے کی دعوت دی ہے۔ سائن ان کریں یا اکاؤنٹ بنائیں، پھر دعوت قبول کریں۔`,
          button: 'دعوت قبول کریں',
          after:
            'یہ لنک 7 دن تک ایک بار کام کرے گا۔ اگر آپ کو اس کی توقع نہیں تھی تو یہ ای میل نظرانداز کر دیں۔',
        }
      : {
          subject: `${inviter} invited you to ${shop} on Hatti`,
          greeting: 'Assalam o alaikum,',
          lead: `${inviter} invited you to work in ${shop} on Hatti, as ${role}. Sign in, or open an account, and accept the invitation.`,
          button: 'Accept the invitation',
          after: "The link works once, for 7 days. If you weren't expecting it, ignore this email.",
        };
  return compose(words, input.to, input.link, input.language);
}

/** An email of `words` around `link`, as text and as HTML, its words right to left in Urdu. */
function compose(
  words: Omit<Words, 'greeting'> & { greeting: string },
  to: string,
  link: string,
  language: AccountEmailLanguage,
): AccountEmail {
  const rtl = language === 'ur';
  return {
    to,
    subject: words.subject,
    text: [words.greeting, words.lead, link, words.after].join('\n\n'),
    html:
      `<!doctype html><html lang="${language}"${rtl ? ' dir="rtl"' : ''}>` +
      '<body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2933">' +
      `<p>${escape(words.greeting)}</p><p>${escape(words.lead)}</p>` +
      `<p><a href="${escape(link)}" style="display:inline-block;padding:10px 16px;` +
      `background:#0f766e;color:#ffffff;border-radius:6px;text-decoration:none">` +
      `${escape(words.button)}</a></p>` +
      `<p dir="ltr" style="font-size:13px;word-break:break-all">${escape(link)}</p>` +
      `<p>${escape(words.after)}</p></body></html>`,
  };
}

/** A name on one line: what a subject or a sentence quotes of it. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
