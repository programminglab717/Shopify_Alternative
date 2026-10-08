import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'danger' | 'destructive';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary hover:bg-primary-strong',
  secondary: 'border border-line bg-surface text-text hover:bg-canvas',
  tertiary: 'text-primary hover:bg-canvas',
  /** A tertiary button for what takes something away: archive, remove, delete. */
  danger: 'text-danger hover:bg-canvas',
  destructive: 'bg-danger text-white hover:opacity-90',
};

/**
 * Hatti UI's button (design system §5): at least 48px tall on phones, its label always shown,
 * and while `busy` a spinner in place of its icon and no second tap.
 */
export function Button({
  variant = 'primary',
  busy = false,
  icon,
  children,
  className = '',
  disabled,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  busy?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-control px-4 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 md:min-h-10 ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {busy ? <LoaderCircle aria-hidden className="size-5 animate-spin" /> : icon}
      {children}
    </button>
  );
}
