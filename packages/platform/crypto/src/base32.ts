/** RFC 4648 base32, the encoding authenticator apps expect for TOTP secrets. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encodes without padding, as otpauth:// URIs use it. */
export function base32Encode(bytes: Uint8Array): string {
  let output = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Decodes, ignoring case, padding, spaces and hyphens (people type secrets in groups). */
export function base32Decode(input: string): Buffer {
  const text = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new RangeError('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}
