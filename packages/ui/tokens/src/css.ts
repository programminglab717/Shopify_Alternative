import {
  colors,
  fontFamilies,
  motion,
  orderStageBadges,
  radius,
  space,
  typeScale,
  type ThemeName,
} from './tokens.js';

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** CSS custom properties for one theme, e.g. `--hatti-color-primary: #0F766E;`. */
export function cssVariables(theme: ThemeName): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(colors[theme])) {
    vars[`--hatti-color-${kebab(name)}`] = value;
  }
  for (const [stage, badge] of Object.entries(orderStageBadges)) {
    vars[`--hatti-badge-${kebab(stage)}-text`] = badge.text;
    vars[`--hatti-badge-${kebab(stage)}-bg`] = badge.background;
  }
  vars['--hatti-font-latin'] = fontFamilies.latin;
  vars['--hatti-font-urdu'] = fontFamilies.urdu;
  for (const [role, sizes] of Object.entries(typeScale)) {
    vars[`--hatti-type-${kebab(role)}-size`] = `${sizes.latin[0]}px`;
    vars[`--hatti-type-${kebab(role)}-line`] = `${sizes.latin[1]}px`;
    vars[`--hatti-type-${kebab(role)}-size-ur`] = `${sizes.urdu[0]}px`;
    vars[`--hatti-type-${kebab(role)}-line-ur`] = `${sizes.urdu[1]}px`;
  }
  for (const [step, px] of Object.entries(space)) vars[`--hatti-space-${step}`] = `${px}px`;
  for (const [name, px] of Object.entries(radius)) vars[`--hatti-radius-${name}`] = `${px}px`;
  vars['--hatti-motion-fast'] = `${motion.durationMs.fast}ms`;
  vars['--hatti-motion-base'] = `${motion.durationMs.base}ms`;
  vars['--hatti-motion-easing'] = motion.easing;
  return vars;
}

/**
 * A stylesheet with light variables on :root, and dark variables both for an explicit
 * [data-theme="dark"] and for the system preference unless light is forced.
 */
export function themeStylesheet(): string {
  const block = (selector: string, theme: ThemeName, indent = '') =>
    `${indent}${selector} {\n${Object.entries(cssVariables(theme))
      .map(([name, value]) => `${indent}  ${name}: ${value};`)
      .join('\n')}\n${indent}}`;
  return [
    block(':root', 'light'),
    block(':root[data-theme="dark"]', 'dark'),
    `@media (prefers-color-scheme: dark) {\n${block(':root:not([data-theme="light"])', 'dark', '  ')}\n}`,
  ].join('\n\n');
}
