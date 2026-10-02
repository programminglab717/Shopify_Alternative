import { escapeHtml, trusted, type Html } from './html.js';

/**
 * Code 128's symbols, as the widths of their bars and spaces in modules, bar first: values 0 to
 * 102, then Start A, B and C (103 to 105) and Stop (106), as ISO/IEC 15417 tables them.
 */
export const CODE128_PATTERNS: readonly string[] = [
  '212222',
  '222122',
  '222221',
  '121223',
  '121322',
  '131222',
  '122213',
  '122312',
  '132212',
  '221213',
  '221312',
  '231212',
  '112232',
  '122132',
  '122231',
  '113222',
  '123122',
  '123221',
  '223211',
  '221132',
  '221231',
  '213212',
  '223112',
  '312131',
  '311222',
  '321122',
  '321221',
  '312212',
  '322112',
  '322211',
  '212123',
  '212321',
  '232121',
  '111323',
  '131123',
  '131321',
  '112313',
  '132113',
  '132311',
  '211313',
  '231113',
  '231311',
  '112133',
  '112331',
  '132131',
  '113123',
  '113321',
  '133121',
  '313121',
  '211331',
  '231131',
  '213113',
  '213311',
  '213131',
  '311123',
  '311321',
  '331121',
  '312113',
  '312311',
  '332111',
  '314111',
  '221411',
  '431111',
  '111224',
  '111422',
  '121124',
  '121421',
  '141122',
  '141221',
  '112214',
  '112412',
  '122114',
  '122411',
  '142112',
  '142211',
  '241211',
  '221114',
  '413111',
  '241112',
  '134111',
  '111242',
  '121142',
  '121241',
  '114212',
  '124112',
  '124211',
  '411212',
  '421112',
  '421211',
  '212141',
  '214121',
  '412121',
  '111143',
  '111341',
  '131141',
  '114113',
  '114311',
  '411113',
  '411311',
  '113141',
  '114131',
  '311141',
  '411131',
  '211412',
  '211214',
  '211232',
  '2331112',
];

const START_B = 104;
const STOP = 106;
/** Blank modules either side, which scanners need to find the code. */
const QUIET_ZONE = 10;

/** Whether Code 128 draws `value` here: printable ASCII, from a space to a tilde, 1 to 80 of them. */
export function isCode128(value: string): boolean {
  return /^[ -~]{1,80}$/.test(value);
}

/**
 * The symbols that draw `value` in Code 128's code set B: Start B, a symbol a character, the check
 * symbol (the start's value and each character's times its place, modulo 103), and Stop.
 */
export function code128Symbols(value: string): number[] {
  if (!isCode128(value)) throw new Error('Code 128 draws printable ASCII, 1 to 80 characters');
  const codes = [...value].map((char) => char.charCodeAt(0) - 32);
  const check = codes.reduce((sum, code, index) => sum + code * (index + 1), START_B) % 103;
  return [START_B, ...codes, check, STOP];
}

/** The widths, in modules, of `value`'s bars and spaces in turn, a bar first, quiet zones apart. */
export function code128Widths(value: string): number[] {
  return code128Symbols(value).flatMap((symbol) => [...CODE128_PATTERNS[symbol]!].map(Number));
}

/**
 * `value` as a Code 128 barcode in an inline SVG as wide as its box (class `barcode`), its bars
 * drawn at whole modules with the quiet zone either side, and `value` its accessible name. Couriers'
 * tracking numbers are printable ASCII; anything else throws.
 */
export function code128(value: string): Html {
  let x = QUIET_ZONE;
  const bars: string[] = [];
  code128Widths(value).forEach((width, index) => {
    if (index % 2 === 0) bars.push(`<rect x="${x}" width="${width}" height="1"/>`);
    x += width;
  });
  const width = x + QUIET_ZONE;
  return trusted(
    `<svg class="barcode" viewBox="0 0 ${width} 1" preserveAspectRatio="none" ` +
      `shape-rendering="crispEdges" role="img" aria-label="${escapeHtml(value)}">` +
      `${bars.join('')}</svg>`,
  );
}
