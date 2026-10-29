import Link from 'next/link';
import { pendingSignIn, sendCode, verifyCode } from '@/app/account/actions';
import { languageOf } from '@/lib/language';
import { wordsOf, type Words } from '@/lib/words';

export const metadata = { title: 'Sign in' };

/** What went wrong, as the Storefront API's code for it says. */
function problemOf(error: string | undefined, words: Words): string | null {
  switch (error) {
    case 'INVALID':
      return words.errorInvalid;
    case 'CODE_WRONG':
      return words.errorWrong;
    case 'CODE_EXPIRED':
      return words.errorExpired;
    case 'TOO_MANY_REQUESTS':
      return words.errorTooMany;
    default:
      return null;
  }
}

// The shopper's mobile number, then the code sent to it (ADR-944), as the shop's own sign-in.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; error?: string }>;
}) {
  const { step, error } = await searchParams;
  const words = wordsOf(await languageOf());
  const problem = problemOf(error, words);
  const pending = step === 'code' ? await pendingSignIn() : null;
  return (
    <section className="sign-in">
      <h1>{words.signInTitle}</h1>
      {problem && (
        <p className="problem" role="alert">
          {problem}
        </p>
      )}
      {pending ? (
        <form action={verifyCode}>
          <p>
            {words.codeSentTo} <bdi>{pending.sentTo}</bdi>
          </p>
          <label>
            {words.code}
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={12}
            />
          </label>
          <button type="submit">{words.verify}</button>
          <Link href="/account/login">{words.otherNumber}</Link>
        </form>
      ) : (
        <form action={sendCode}>
          <label>
            {words.phone}
            <input
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="0300 1234567"
              required
              maxLength={40}
              dir="ltr"
            />
          </label>
          <fieldset>
            <legend>{words.sendBy}</legend>
            <label>
              <input type="radio" name="channel" value="WHATSAPP" defaultChecked /> {words.whatsapp}
            </label>
            <label>
              <input type="radio" name="channel" value="SMS" /> {words.sms}
            </label>
          </fieldset>
          <button type="submit">{words.sendCode}</button>
        </form>
      )}
    </section>
  );
}
