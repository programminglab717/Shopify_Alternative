import { describe, expect, it } from 'vitest';
import {
  WCAG_AA,
  colors,
  contrastRatio,
  cssVariables,
  orderStageBadges,
  themeStylesheet,
  type ThemeName,
} from './index.js';

const themes: ThemeName[] = ['light', 'dark'];

describe('contrastRatio', () => {
  it('matches WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777', '#FFF')).toBeCloseTo(4.48, 2);
  });

  it('rejects malformed colours', () => {
    expect(() => contrastRatio('teal', '#FFFFFF')).toThrow(RangeError);
  });
});

describe.each(themes)('%s theme', (theme) => {
  const c = colors[theme];

  it.each([
    ['text on canvas', c.text, c.canvas],
    ['text on surface', c.text, c.surface],
    ['secondary text on canvas', c.textSecondary, c.canvas],
    ['secondary text on surface', c.textSecondary, c.surface],
    ['text on primary', c.onPrimary, c.primary],
    ['text on accent', c.onAccent, c.accent],
    ['primary as text on surface', c.primary, c.surface],
    ['success text', c.success, c.surface],
    ['warning text', c.warning, c.surface],
    ['danger text', c.danger, c.surface],
    ['info text', c.info, c.surface],
  ])('%s meets AA for body text', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(WCAG_AA.text);
  });

  it('has a focus ring visible on canvas and surface', () => {
    expect(contrastRatio(c.focus, c.canvas)).toBeGreaterThanOrEqual(WCAG_AA.nonText);
    expect(contrastRatio(c.focus, c.surface)).toBeGreaterThanOrEqual(WCAG_AA.nonText);
  });
});

describe('order stage badges', () => {
  it.each(Object.entries(orderStageBadges))('%s meets AA', (_stage, badge) => {
    expect(contrastRatio(badge.text, badge.background)).toBeGreaterThanOrEqual(WCAG_AA.text);
  });
});

describe('CSS output', () => {
  it('names variables in kebab case', () => {
    const vars = cssVariables('light');
    expect(vars['--hatti-color-primary']).toBe('#0F766E');
    expect(vars['--hatti-color-text-secondary']).toBe('#475569');
    expect(vars['--hatti-badge-out-for-delivery-bg']).toBe('#CFFAFE');
    expect(vars['--hatti-type-body-sm-size-ur']).toBe('16px');
    expect(vars['--hatti-space-4']).toBe('16px');
  });

  it('emits light, explicit dark and system dark blocks', () => {
    const css = themeStylesheet();
    expect(css).toContain(':root {');
    expect(css).toContain(':root[data-theme="dark"] {');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('--hatti-color-canvas: #0B1220;');
  });
});
