import { Database } from '@hatti/db';
import { PartnerThemesService } from '@hatti/identity/public';
import { formatMoney, money } from '@hatti/money';
import { fromPublicId, toPublicId } from '@hatti/ids';
import { loadPartnerPayoutsConfig } from './config.js';

// Hatti's review of designers' themes for the theme store (OS-20, ADR-853): for Hatti's own people,
// by whoever runs Hatti, never through the Admin API. `list` shows each theme, those waiting
// first; `list-theme` puts it in the store for every shop, once checked against the review list in
// docs/developers/README.md, `hatti theme check --url <its preview link>` among it (ADR-968);
// `unlist` takes it out, the shops that bought it keeping it.
//
//   pnpm --filter @hatti/core partner-themes list
//   pnpm --filter @hatti/core partner-themes list-theme <thls_…>
//   pnpm --filter @hatti/core partner-themes unlist <thls_…>

const [command, listingId] = process.argv.slice(2);
if (!(command === 'list' || ((command === 'list-theme' || command === 'unlist') && listingId))) {
  console.error('Usage: partner-themes list | list-theme <theme id> | unlist <theme id>');
  process.exit(2);
}

const config = loadPartnerPayoutsConfig();
const database = new Database({
  appUrl: config.DATABASE_IDENTITY_URL,
  applicationName: 'partner-themes',
});
try {
  const themes = new PartnerThemesService({ db: database.app });
  if (command === 'list') {
    const all = await themes.all();
    if (all.length === 0) console.log('No designer has offered a theme.');
    for (const theme of all) {
      const price = theme.price === 0n ? 'free' : formatMoney(money(theme.price, 'PKR'));
      console.log(
        `${toPublicId('themeListing', theme.id)}  ${theme.listed ? '[listed]' : '[waiting]'} ` +
          `${theme.name} by ${theme.designer}, ${price}, on ${theme.base}\n` +
          `    preview it on its development store: ${toPublicId('shop', theme.sourceShopId)}, ` +
          `theme ${toPublicId('theme', theme.sourceThemeId)}`,
      );
    }
  } else {
    let id: string;
    try {
      id = fromPublicId(listingId!, 'themeListing');
    } catch {
      console.error(`${listingId} is not a theme store ID (thls_…).`);
      process.exit(2);
    }
    const theme = await themes.review(id, command === 'list-theme');
    console.log(
      theme
        ? `${theme.name} is ${theme.listed ? 'in the theme store' : 'out of the theme store'}.`
        : `No theme has the ID ${listingId}.`,
    );
    if (!theme) process.exitCode = 1;
  }
} finally {
  await database.close();
}
