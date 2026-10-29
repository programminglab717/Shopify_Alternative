import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { switchLanguage } from '@/app/actions';
import { storefront } from '@/lib/hatti';
import { languageOf } from '@/lib/language';
import { SHOP_QUERY } from '@/lib/queries';
import { wordsOf } from '@/lib/words';
import './globals.css';

// Every page is the shop's as it is now: rendered as asked, its catalog kept a minute (lib/hatti.ts).
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { shop } = await storefront<{ shop: { name: string } }>(SHOP_QUERY);
  return { title: { default: shop.name, template: `%s · ${shop.name}` } };
}

export default async function Layout({ children }: { children: ReactNode }) {
  const { shop } = await storefront<{ shop: { name: string } }>(SHOP_QUERY);
  const language = await languageOf();
  const words = wordsOf(language);
  return (
    // In Urdu, right to left (ADR-926).
    <html lang={language} dir={language === 'ur' ? 'rtl' : 'ltr'}>
      <body>
        <header className="header">
          <Link href="/" className="brand">
            {shop.name}
          </Link>
          <nav className="nav">
            <form action={switchLanguage}>
              <input type="hidden" name="to" value={language === 'ur' ? 'en' : 'ur'} />
              <button type="submit" className="language" lang={language === 'ur' ? 'en' : 'ur'}>
                {words.switchTo}
              </button>
            </form>
            <Link href="/cart">{words.cart}</Link>
          </nav>
        </header>
        <main className="page">{children}</main>
        <footer className="footer">{words.footer}</footer>
      </body>
    </html>
  );
}
