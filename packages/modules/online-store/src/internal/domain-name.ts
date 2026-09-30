import { domainToASCII } from 'node:url';

/** The most domains of its own a shop may connect. */
export const DOMAIN_LIMIT = 10;

/** A host as DNS has it, as the domains table checks it: two labels at least, a TLD of letters. */
const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A host as a shop types or pastes it, as DNS has it: lowercase, an internationalised name in
 * its xn-- form, without a scheme, path or final dot, "https://www.Zari.pk/" giving
 * "www.zari.pk". Null for anything a storefront cannot answer at: an address, a port, a name of
 * one label.
 */
export function hostOf(input: string): string | null {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
  if (text === '' || /[:@\s]/.test(text)) return null;
  const ascii = domainToASCII(text);
  return ascii.length <= 253 && HOST.test(ascii) ? ascii : null;
}

/** Whether two hosts are the same to DNS, which ignores case and a final dot. */
export function sameHost(a: string, b: string): boolean {
  return a.toLowerCase().replace(/\.$/, '') === b.toLowerCase().replace(/\.$/, '');
}
