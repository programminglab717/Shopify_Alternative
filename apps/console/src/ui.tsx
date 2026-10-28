import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Button({
  variant = 'primary',
  busy = false,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
  busy?: boolean;
}) {
  const look =
    variant === 'primary'
      ? 'bg-primary text-on-primary hover:bg-primary-strong'
      : 'border border-line bg-surface hover:bg-canvas';
  return (
    <button
      type="button"
      disabled={busy || rest.disabled}
      aria-busy={busy || undefined}
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-control px-4 font-medium disabled:cursor-not-allowed disabled:opacity-60 ${look} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Alert({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'danger';
  children: ReactNode;
}) {
  const colour = { success: 'text-success', warning: 'text-warning', danger: 'text-danger' }[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`rounded-card border border-line bg-surface p-3 ${colour}`}
    >
      {children}
    </div>
  );
}

export const Card = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <section className={`rounded-card border border-line bg-surface p-4 ${className}`}>
    {children}
  </section>
);

/** A time as Hatti's people read it, in Pakistan's time. */
export const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Karachi',
  }).format(new Date(iso));
