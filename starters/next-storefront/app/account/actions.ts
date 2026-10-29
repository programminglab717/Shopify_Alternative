'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { storefront } from '@/lib/hatti';
import { languageCode, languageOf } from '@/lib/language';
import {
  CUSTOMER_ACCESS_TOKEN_CREATE_MUTATION,
  CUSTOMER_ACCESS_TOKEN_DELETE_MUTATION,
  CUSTOMER_LOGIN_CODE_SEND_MUTATION,
} from '@/lib/queries';
import type { CustomerUserError } from '@/lib/types';

// Shoppers' sign-in (ADR-944), as the shop's own pages sign them in: their mobile number, then
// the code the Storefront API sent it (ADR-943). The number waits in a cookie only this server
// reads, ten minutes, as long as a code lasts; the customer access token the code gives is kept
// in another until it expires.

const SIGN_IN_COOKIE = 'hatti_sign_in';
const CUSTOMER_COOKIE = 'hatti_customer';

const secure = process.env.NODE_ENV === 'production';

/** The shopper's address, as the host in front of this site says it, for their sign-ins' count. */
async function buyerIp(): Promise<string | null> {
  const asked = await headers();
  const forwarded = asked.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || asked.get('x-real-ip') || null;
}

/** The signed-in shopper's customer access token; null for none. */
export async function customerToken(): Promise<string | null> {
  return (await cookies()).get(CUSTOMER_COOKIE)?.value ?? null;
}

/** Where the code went, masked, while the shopper types it; null for none. */
export async function pendingSignIn(): Promise<{ phone: string; sentTo: string } | null> {
  const kept = (await cookies()).get(SIGN_IN_COOKIE)?.value;
  if (!kept) return null;
  try {
    const pending = JSON.parse(kept) as { phone?: unknown; sentTo?: unknown };
    return typeof pending.phone === 'string' && typeof pending.sentTo === 'string'
      ? { phone: pending.phone, sentTo: pending.sentTo }
      : null;
  } catch {
    return null;
  }
}

/** Has a code sent to the number typed, on WhatsApp unless SMS was chosen, then asks for it. */
export async function sendCode(form: FormData): Promise<void> {
  const phone = String(form.get('phone') ?? '').trim();
  const channel = form.get('channel') === 'SMS' ? 'SMS' : 'WHATSAPP';
  const language = await languageOf();
  const { customerLoginCodeSend: sent } = await storefront<{
    customerLoginCodeSend: { sentTo: string | null; customerUserErrors: CustomerUserError[] };
  }>(
    // The code's message in the shopper's language.
    CUSTOMER_LOGIN_CODE_SEND_MUTATION,
    { phone, channel, language: languageCode(language) },
    { cache: 'none', buyerIp: await buyerIp() },
  );
  const refused = sent.customerUserErrors[0];
  if (refused || !sent.sentTo) redirect(`/account/login?error=${refused?.code ?? 'INVALID'}`);
  (await cookies()).set(SIGN_IN_COOKIE, JSON.stringify({ phone, sentTo: sent.sentTo }), {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 10 * 60,
    path: '/account',
  });
  redirect('/account/login?step=code');
}

/** Signs the shopper in with the code they typed, then shows their account. */
export async function verifyCode(form: FormData): Promise<void> {
  const pending = await pendingSignIn();
  if (!pending) redirect('/account/login?error=CODE_EXPIRED');
  const { customerAccessTokenCreateWithCode: signed } = await storefront<{
    customerAccessTokenCreateWithCode: {
      customerAccessToken: { accessToken: string; expiresAt: string } | null;
      customerUserErrors: CustomerUserError[];
    };
  }>(
    CUSTOMER_ACCESS_TOKEN_CREATE_MUTATION,
    { phone: pending.phone, code: String(form.get('code') ?? '') },
    { cache: 'none', buyerIp: await buyerIp() },
  );
  const jar = await cookies();
  const refused = signed.customerUserErrors[0];
  if (refused || !signed.customerAccessToken) {
    // An expired code needs the number again, for a new one; a wrong one, another try.
    if (refused?.code === 'CODE_EXPIRED') {
      jar.delete({ name: SIGN_IN_COOKIE, path: '/account' });
      redirect('/account/login?error=CODE_EXPIRED');
    }
    redirect(`/account/login?step=code&error=${refused?.code ?? 'CODE_WRONG'}`);
  }
  jar.delete({ name: SIGN_IN_COOKIE, path: '/account' });
  jar.set(CUSTOMER_COOKIE, signed.customerAccessToken.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    expires: new Date(signed.customerAccessToken.expiresAt),
    path: '/',
  });
  redirect('/account');
}

/** Signs the shopper out, here and at the shop. */
export async function signOut(): Promise<void> {
  const token = await customerToken();
  if (token) {
    await storefront(
      CUSTOMER_ACCESS_TOKEN_DELETE_MUTATION,
      { customerAccessToken: token },
      { cache: 'none' },
    );
  }
  (await cookies()).delete(CUSTOMER_COOKIE);
  redirect('/');
}
