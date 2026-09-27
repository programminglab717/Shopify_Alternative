/**
 * Design tokens from docs/design/01-design-principles-and-system.md §4. The palette is a
 * starting proposal for the brand designer; the contrast tests keep any change accessible.
 */

export type ThemeName = 'light' | 'dark';

export interface ThemeColors {
  primary: string;
  primaryStrong: string;
  /** Text and icons on a primary background. */
  onPrimary: string;
  accent: string;
  onAccent: string;
  canvas: string;
  surface: string;
  text: string;
  textSecondary: string;
  border: string;
  /** Focus ring, at least 3:1 against canvas and surface. */
  focus: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
}

export const colors: Readonly<Record<ThemeName, Readonly<ThemeColors>>> = {
  light: {
    primary: '#0F766E',
    primaryStrong: '#115E59',
    onPrimary: '#FFFFFF',
    accent: '#F59E0B',
    onAccent: '#0F172A',
    canvas: '#F8FAFC',
    surface: '#FFFFFF',
    text: '#0F172A',
    textSecondary: '#475569',
    border: '#CBD5E1',
    focus: '#0F766E',
    success: '#15803D',
    warning: '#B45309',
    danger: '#B91C1C',
    info: '#1D4ED8',
  },
  dark: {
    primary: '#2DD4BF',
    primaryStrong: '#5EEAD4',
    onPrimary: '#0B1220',
    accent: '#FBBF24',
    onAccent: '#0B1220',
    canvas: '#0B1220',
    surface: '#111827',
    text: '#E5E7EB',
    textSecondary: '#94A3B8',
    border: '#334155',
    focus: '#2DD4BF',
    success: '#4ADE80',
    warning: '#FBBF24',
    danger: '#F87171',
    info: '#60A5FA',
  },
};

/** Order stages as merchants see them. Always shown as colour + icon + text. */
export type OrderStage =
  | 'needsConfirmation'
  | 'confirmed'
  | 'packed'
  | 'inTransit'
  | 'outForDelivery'
  | 'delivered'
  | 'deliveryIssue'
  | 'returned'
  | 'cancelled';

export const orderStageBadges: Readonly<
  Record<OrderStage, Readonly<{ text: string; background: string }>>
> = {
  needsConfirmation: { text: '#92400E', background: '#FEF3C7' },
  confirmed: { text: '#1E40AF', background: '#DBEAFE' },
  packed: { text: '#3730A3', background: '#E0E7FF' },
  inTransit: { text: '#5B21B6', background: '#EDE9FE' },
  outForDelivery: { text: '#155E75', background: '#CFFAFE' },
  delivered: { text: '#166534', background: '#DCFCE7' },
  deliveryIssue: { text: '#9A3412', background: '#FFEDD5' },
  returned: { text: '#991B1B', background: '#FEE2E2' },
  cancelled: { text: '#475569', background: '#F1F5F9' },
};

export const fontFamilies = {
  latin: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  urdu: '"Noto Nastaliq Urdu", "Jameel Noori Nastaleeq", serif',
} as const;

export type TypeRole = 'display' | 'title' | 'body' | 'bodySm' | 'caption';

/** Size and line height in px. Nastaliq needs a larger size and far more line height. */
export const typeScale: Readonly<
  Record<TypeRole, Readonly<{ latin: readonly [number, number]; urdu: readonly [number, number] }>>
> = {
  display: { latin: [28, 36], urdu: [32, 60] },
  title: { latin: [20, 28], urdu: [23, 44] },
  body: { latin: [16, 24], urdu: [18, 36] },
  bodySm: { latin: [14, 20], urdu: [16, 32] },
  caption: { latin: [12, 16], urdu: [14, 28] },
};

/** 4px base spacing scale, in px. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
  12: 48,
} as const;

/** Corner radius in px: controls, cards, bottom sheets. */
export const radius = { control: 8, card: 12, sheet: 16, pill: 9999 } as const;

/** Minimum touch target in px (48dp). */
export const touchTarget = 48;

export const motion = {
  durationMs: { fast: 150, base: 200 },
  easing: 'cubic-bezier(0, 0, 0.2, 1)',
} as const;
