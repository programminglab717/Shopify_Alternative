import { Database } from '@hatti/db';
import { liftSuppression, normalizeEmail, suppressionOf } from '@hatti/identity/public';
import { loadEmailSuppressionConfig } from './config.js';
import { sesSuppressionsOf } from './emails.js';

// Why Hatti sends an address no more email, and lifting it (ADR-170, ADR-200): for Hatti's own
// people, by whoever runs Hatti, never through the Admin API. A lift takes the address off Hatti's
// list and SES's, a complaint as a bounce: once its holder asks from the address itself, as by
// writing to Hatti's support from it.
//
//   pnpm --filter @hatti/core email-suppression show someone@example.pk
//   pnpm --filter @hatti/core email-suppression lift someone@example.pk

const [command, input] = process.argv.slice(2);
const email = input ? normalizeEmail(input) : null;
if ((command !== 'show' && command !== 'lift') || !email) {
  console.error('Usage: email-suppression show|lift <email>');
  process.exit(2);
}

const config = loadEmailSuppressionConfig();
const ses = sesSuppressionsOf(config);
const database = new Database({
  appUrl: config.DATABASE_IDENTITY_URL,
  applicationName: 'email-suppression',
});
try {
  if (command === 'show') {
    const kept = await suppressionOf(database.app, email);
    console.log(
      kept
        ? `Hatti: no email since a ${kept.reason} heard ${kept.updatedAt.toISOString()}` +
            (kept.detail ? ` (${kept.detail})` : '')
        : 'Hatti: emails it',
    );
    if (!ses) console.log('SES: not set up here');
    else {
      const listed = await ses.reasonOf(email).catch(() => 'unreachable' as const);
      console.log(
        listed === 'unreachable'
          ? 'SES: could not be asked'
          : listed
            ? `SES: on its list for a ${listed}`
            : 'SES: emails it',
      );
    }
  } else {
    const lifted = await liftSuppression(database.app, ses, email, { complaints: true });
    if (lifted === 'lifted') console.log(`${email} is sent Hatti's emails again.`);
    else if (lifted === 'not_suppressed') {
      console.log(`${email} is on neither Hatti's list nor SES's.`);
    } else {
      console.error('SES could not be asked: nothing was lifted. Try again.');
      process.exitCode = 1;
    }
  }
} finally {
  await database.close();
}
