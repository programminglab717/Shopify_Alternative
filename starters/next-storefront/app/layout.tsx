import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { storefront } from '@/lib/hatti';
import { SHOP_QUERY } from '@/lib/queries';
import './globals.css';

// Every page is the shop's as it is now: rendered as asked, its catalog kept a minute (lib/hatti.ts).
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { shop } = await storefront<{ shop: { name: string } }>(SHOP_QUERY);
  return { title: { default: shop.name, template: `%s · ${shop.name}` } };
}

export default async function Layout({ children }: { children: ReactNode }) {
  const { shop } = await storefront<{ shop: { name: string } }>(SHOP_QUERY);
  return (
    <html lang="en">
      <body>
        <header className="header">
          <Link href="/" className="brand">
            {shop.name}
          </Link>
          <Link href="/cart">Cart</Link>
        </header>
        <main className="page">{children}</main>
        <footer className="footer">Pay cash when your order arrives, or online at checkout.</footer>
      </body>
    </html>
  );
}
