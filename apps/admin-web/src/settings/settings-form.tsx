import { useId } from 'react';
import type { ReactNode } from 'react';
import type { UserError } from '../api/types';
import type { Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { Alert } from '../ui/feedback';

/** A list as the merchant types it, commas between: cities or tags, each once. */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,،\n]/)
        .map((each) => each.trim())
        .filter(Boolean),
    ),
  ];
}

/** An amount as the API takes it: what was typed, or null for a blank. */
export function amountInput(text: string): string | null {
  return text.trim() || null;
}

/** A whole number as typed: null for a blank, NaN for what is not one. */
export function parseWhole(text: string): number | null {
  const plain = text.trim();
  if (!plain) return null;
  return /^\d{1,4}$/.test(plain) ? Number(plain) : Number.NaN;
}

/** A risk score shown as a percentage, 0 to 100, for the 0-to-1 score the API keeps. */
export function percentText(score: number | null | undefined): string {
  return score === null || score === undefined ? '' : String(Math.round(score * 100));
}

/** A percentage typed for a score: null for a blank, NaN for what is not 0 to 100. */
export function parseScore(text: string): number | null {
  const percent = parseWhole(text);
  if (percent === null || Number.isNaN(percent)) return percent;
  return percent <= 100 ? percent / 100 : Number.NaN;
}

/**
 * A problem the API found with a setting, named in the merchant's words: the last part of its
 * field the page knows, after any it adds for where in a list it is.
 */
export function settingProblem(
  error: UserError,
  t: Translate,
  labels: Partial<Record<string, MessageKey>>,
  where?: (field: string[]) => string | null,
): string {
  const field = error.field ?? [];
  const named = [...field].reverse().find((part) => labels[part]);
  const names = [where?.(field), named && t(labels[named]!)].filter(Boolean);
  return names.length > 0 ? `${names.join(' · ')}: ${error.message}` : error.message;
}

export function Problems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <Alert tone="danger">
      <ul className="flex flex-col gap-1">
        {problems.map((problem, index) => (
          <li key={index}>{problem}</li>
        ))}
      </ul>
    </Alert>
  );
}

/** A checkbox with its label beside it and a hint below, the whole row tappable. */
export function CheckField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-12 cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 size-5 shrink-0 accent-[var(--hatti-color-primary)]"
      />
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        {hint && <span className="text-secondary">{hint}</span>}
      </span>
    </label>
  );
}

/** A labelled choice among a few. */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="min-h-12 rounded-control border border-line bg-surface px-3 md:min-h-10"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Two fields side by side from the tablet up, one above the other on phones. */
export function Pair({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">{children}</div>;
}
