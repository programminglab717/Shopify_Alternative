import { useId } from 'react';
import type { InputHTMLAttributes } from 'react';

/**
 * A labelled text field (design system §5, §8): its label always shown, its hint and error tied
 * to it for screen readers, and at least 48px tall on phones. `ltr` keeps numbers, phones, codes
 * and emails left to right in Urdu too.
 */
export function TextField({
  label,
  hint,
  error,
  ltr = false,
  className = '',
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string | null;
  ltr?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <input
        id={id}
        dir={ltr ? 'ltr' : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        className={`min-h-12 rounded-control border bg-surface px-3 text-text md:min-h-10 ${
          error ? 'border-danger' : 'border-line'
        } ${ltr ? 'text-start' : ''}`}
        {...input}
      />
      {hint && (
        <p id={hintId} className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-danger text-[length:var(--hatti-type-body-sm-size)]">
          {error}
        </p>
      )}
    </div>
  );
}
