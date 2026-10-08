import { CircleAlert, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

/** A card on the canvas: borders first, shadows sparingly (design system §4.3). */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-card border border-line bg-surface ${className}`}>
      {children}
    </section>
  );
}

/** While something loads: the words for screen readers, a spinner for the eye. */
export function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 p-8 text-secondary">
      <LoaderCircle aria-hidden className="size-5 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

/** What went wrong and what to do about it, with a way to try again. */
export function ErrorState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 p-8 text-center">
      <CircleAlert aria-hidden className="size-8 text-danger" />
      <p>{message}</p>
      {action}
    </div>
  );
}

/** Nothing to show yet, and the next thing to do (design system §5). */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center">
      {icon}
      <p className="font-medium">{title}</p>
      {body && <p className="text-secondary">{body}</p>}
      {action}
    </div>
  );
}

/** An inline alert: colour, icon and words, never colour alone. */
export function Alert({
  tone,
  children,
}: {
  tone: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
}) {
  const tones = {
    info: 'border-info text-info',
    warning: 'border-warning text-warning',
    danger: 'border-danger text-danger',
    success: 'border-success text-success',
  } as const;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded-control border-s-4 bg-surface p-3 ${tones[tone]}`}
    >
      <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0" />
      <div className="text-text">{children}</div>
    </div>
  );
}
