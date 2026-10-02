// Hatti's own emails about accounts (ONB-01, ADR-165): a link that proves an account's email, and
// one that resets its password, in English or Urdu. Each link carries a token of its own; only a
// digest of it is kept.

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

export type AccountEmailKind = 'verify_email' | 'reset_password';

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
  const greeting = words.greeting(input.name);
  const rtl = input.language === 'ur';
  return {
    to: input.to,
    subject: words.subject,
    text: [greeting, words.lead, input.link, words.after].join('\n\n'),
    html:
      `<!doctype html><html lang="${input.language}"${rtl ? ' dir="rtl"' : ''}>` +
      '<body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2933">' +
      `<p>${escape(greeting)}</p><p>${escape(words.lead)}</p>` +
      `<p><a href="${escape(input.link)}" style="display:inline-block;padding:10px 16px;` +
      `background:#0f766e;color:#ffffff;border-radius:6px;text-decoration:none">` +
      `${escape(words.button)}</a></p>` +
      `<p dir="ltr" style="font-size:13px;word-break:break-all">${escape(input.link)}</p>` +
      `<p>${escape(words.after)}</p></body></html>`,
  };
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
