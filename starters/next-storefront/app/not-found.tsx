import Link from 'next/link';

export default function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p>
        This page isn&apos;t here. <Link href="/">Back to the shop</Link>
      </p>
    </>
  );
}
