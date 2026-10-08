import type { OrderStage as BadgeColour } from '@hatti/tokens';
import type { LucideIcon } from 'lucide-react';

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * A status as a pill (docs/design/01 §4.1): one of the design system's badge colours, an icon and
 * words, never colour alone.
 */
export function Badge({
  colour,
  icon: Icon,
  label,
}: {
  colour: BadgeColour;
  icon: LucideIcon;
  label: string;
}) {
  const badge = kebab(colour);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[length:var(--hatti-type-body-sm-size)] font-medium whitespace-nowrap"
      style={{
        color: `var(--hatti-badge-${badge}-text)`,
        backgroundColor: `var(--hatti-badge-${badge}-bg)`,
      }}
    >
      <Icon aria-hidden className="size-4" />
      {label}
    </span>
  );
}
