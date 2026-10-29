import Link from 'next/link';
import { languageOf } from '@/lib/language';
import { wordsOf } from '@/lib/words';

export default async function NotFound() {
  const words = wordsOf(await languageOf());
  return (
    <>
      <h1>{words.notFound}</h1>
      <p>
        {words.notHere} <Link href="/">{words.back}</Link>
      </p>
    </>
  );
}
