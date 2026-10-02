import { Database } from '@hatti/db';
import { SupportAccessService } from '@hatti/identity/public';
import { loadSupportAgentConfig } from './config.js';

// Makes an account one of Hatti's support agents, or no longer one (ADR-156): for Hatti's own
// people, by whoever runs Hatti, never through the Admin API. The account signs up first, and
// sets up a second factor before it looks at any shop.
//
//   pnpm --filter @hatti/core support-agent add someone@hatti.pk
//   pnpm --filter @hatti/core support-agent remove someone@hatti.pk

const [command, email] = process.argv.slice(2);
if ((command !== 'add' && command !== 'remove') || !email) {
  console.error('Usage: support-agent add|remove <email>');
  process.exit(2);
}

const config = loadSupportAgentConfig();
const database = new Database({
  appUrl: config.DATABASE_IDENTITY_URL,
  applicationName: 'support-agent',
});
try {
  const found = await new SupportAccessService({ db: database.app }).setAgent(
    email,
    command === 'add',
  );
  if (!found) {
    console.error(`No account signs in as ${email}: it signs up first.`);
    process.exitCode = 1;
  } else {
    console.log(
      command === 'add'
        ? `${email} is one of Hatti's support agents.`
        : `${email} is no longer one of Hatti's support agents.`,
    );
  }
} finally {
  await database.close();
}
