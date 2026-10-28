import { Database } from '@hatti/db';
import { ExpertsService } from '@hatti/identity/public';
import { formatMoney, money } from '@hatti/money';
import { fromPublicId, toPublicId } from '@hatti/ids';
import { loadPartnerPayoutsConfig } from './config.js';

// Hatti's review of partners' expert profiles (PRT-03, ADR-855): for Hatti's own people, by
// whoever runs Hatti, never through the Admin API. `list` shows each profile, those waiting
// first; `list-expert` shows it to shops, once checked against the review list in
// docs/developers/README.md; `unlist` takes it back.
//
//   pnpm --filter @hatti/core partner-experts list
//   pnpm --filter @hatti/core partner-experts list-expert <expt_…>
//   pnpm --filter @hatti/core partner-experts unlist <expt_…>

const [command, expertId] = process.argv.slice(2);
if (!(command === 'list' || ((command === 'list-expert' || command === 'unlist') && expertId))) {
  console.error('Usage: partner-experts list | list-expert <expert id> | unlist <expert id>');
  process.exit(2);
}

const config = loadPartnerPayoutsConfig();
const database = new Database({
  appUrl: config.DATABASE_IDENTITY_URL,
  applicationName: 'partner-experts',
});
try {
  const experts = new ExpertsService({ db: database.app });
  if (command === 'list') {
    const all = await experts.all();
    if (all.length === 0) console.log('No partner has made an expert profile.');
    for (const expert of all) {
      const from =
        expert.startingPrice > 0n
          ? `from ${formatMoney(money(expert.startingPrice, 'PKR'))}`
          : 'ask';
      console.log(
        `${toPublicId('expert', expert.partnerId)}  ${expert.listed ? '[listed]' : '[waiting]'} ` +
          `${expert.businessName}: ${expert.headline}\n` +
          `    ${expert.services.join(', ')} · ${expert.cities.join(', ') || 'anywhere'} · ` +
          `${expert.languages.join(', ')} · ${from}${expert.website ? ` · ${expert.website}` : ''}`,
      );
    }
  } else {
    let id: string;
    try {
      id = fromPublicId(expertId!, 'expert');
    } catch {
      console.error(`${expertId} is not an expert's ID (expt_…).`);
      process.exit(2);
    }
    const expert = await experts.review(id, command === 'list-expert');
    console.log(
      expert
        ? `${expert.businessName} is ${expert.listed ? 'shown to shops' : 'no longer shown to shops'}.`
        : `No expert has the ID ${expertId}.`,
    );
    if (!expert) process.exitCode = 1;
  }
} finally {
  await database.close();
}
