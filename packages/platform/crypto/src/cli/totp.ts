// Prints the current code for an authenticator secret, for local development and demos:
//   pnpm totp JBSWY3DPEHPK3PXP
import { base32Decode } from '../base32.js';
import { totp } from '../totp.js';

const secret = process.argv[2];
if (!secret) {
  console.error('Usage: pnpm totp <base32 secret>');
  process.exit(1);
}
const now = Date.now();
console.log(totp(base32Decode(secret), now));
console.error(`Valid for about ${30 - (Math.floor(now / 1000) % 30)} more seconds`);
