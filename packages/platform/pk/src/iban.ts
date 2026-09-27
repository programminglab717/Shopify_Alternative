/** ISO 13616 mod-97 check. Works for any country's IBAN. */
export function isValidIban(input: string): boolean {
  const iban = input.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = Number.parseInt(char, 36);
    const chunk = value >= 10 ? String(value) : char;
    for (const digit of chunk) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * Validates and normalises a Pakistani IBAN: PK + 2 check digits + 4-letter bank code
 * + 16-digit account number (24 characters in total).
 */
export function normalizePkIban(input: string): string | null {
  const iban = input.replace(/\s+/g, '').toUpperCase();
  if (!/^PK\d{2}[A-Z]{4}\d{16}$/.test(iban)) return null;
  return isValidIban(iban) ? iban : null;
}

/** Groups an IBAN in blocks of four for display: PK36 SCBL 0000 0011 2345 6702. */
export function formatIban(iban: string): string {
  return iban
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1 ');
}
