import { Database } from '@hatti/db';
import { PartnerAppsService } from '@hatti/identity/public';
import { loadPartnerPayoutsConfig } from './config.js';

// Hatti's review of partners' public apps (DEV-05, ADR-851): for Hatti's own people, by whoever
// runs Hatti, never through the Admin API. `list` shows each app, those waiting first, with what
// it asks for and where it sends merchants; `list-app` lets every shop install it, once its
// listing is checked against the review list in docs/developers/README.md; `unlist` takes it
// back to its partner's development stores, the shops that installed it keeping it.
//
//   pnpm --filter @hatti/core partner-apps list
//   pnpm --filter @hatti/core partner-apps list-app <client id>
//   pnpm --filter @hatti/core partner-apps unlist <client id>

const [command, clientId] = process.argv.slice(2);
if (!(command === 'list' || ((command === 'list-app' || command === 'unlist') && clientId))) {
  console.error('Usage: partner-apps list | list-app <client id> | unlist <client id>');
  process.exit(2);
}

const config = loadPartnerPayoutsConfig();
const database = new Database({
  appUrl: config.DATABASE_IDENTITY_URL,
  applicationName: 'partner-apps',
});
try {
  const apps = new PartnerAppsService({ db: database.app });
  if (command === 'list') {
    const all = await apps.all();
    if (all.length === 0) console.log('No partner has registered an app.');
    for (const app of all) {
      console.log(
        `${app.clientId}  ${app.listed ? '[listed]' : '[waiting]'} ${app.name} by ${app.partner}\n` +
          `    ${app.appUrl}  asks ${app.scopes.join(', ')}\n` +
          `    sends merchants back to ${app.redirectUrls.join(', ')}`,
      );
    }
  } else {
    const app = await apps.review(clientId!, command === 'list-app');
    console.log(
      app
        ? `${app.name} is ${app.listed ? 'listed: any shop may install it' : "its partner's alone again"}.`
        : `No app has the client ID ${clientId}.`,
    );
    if (!app) process.exitCode = 1;
  }
} finally {
  await database.close();
}
