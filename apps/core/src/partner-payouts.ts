import { Database } from '@hatti/db';
import { PartnersService } from '@hatti/identity/public';
import { formatMoney, money } from '@hatti/money';
import { loadPartnerPayoutsConfig } from './config.js';

// Pays partners their share of what the stores they brought paid Hatti (PRT-02, ADR-505): for
// Hatti's own people, by whoever runs Hatti, never through the Admin API. `list` says who is
// owed what, and into which account; once the bank transfer is made, `pay` marks everything the
// partner was owed paid by its reference.
//
//   pnpm --filter @hatti/core partner-payouts list
//   pnpm --filter @hatti/core partner-payouts pay <partner's account id> <transfer reference>

const [command, partnerId, ...reference] = process.argv.slice(2);
if (!(command === 'list' || (command === 'pay' && partnerId && reference.length > 0))) {
  console.error('Usage: partner-payouts list | pay <partner account id> <transfer reference>');
  process.exit(2);
}

const rupees = (paisa: bigint) => formatMoney(money(paisa, 'PKR'));
const config = loadPartnerPayoutsConfig();
const database = new Database({
  appUrl: config.DATABASE_IDENTITY_URL,
  applicationName: 'partner-payouts',
});
try {
  const partners = new PartnersService({ db: database.app });
  if (command === 'list') {
    const owed = await partners.owed();
    if (owed.length === 0) console.log('No partner is owed anything.');
    for (const partner of owed) {
      const account = partner.payout
        ? `${partner.payout.title}, ${partner.payout.iban}`
        : 'no bank account given yet';
      console.log(
        `${partner.userId}  ${partner.businessName} <${partner.email}>  ${rupees(partner.owed)} ` +
          `of ${partner.entries} invoice(s)  into ${account}`,
      );
    }
  } else {
    const paid = await partners.payOut(partnerId!, reference.join(' '));
    console.log(
      paid > 0n
        ? `Marked ${rupees(paid)} paid to ${partnerId}.`
        : `${partnerId} was owed nothing: nothing marked.`,
    );
  }
} finally {
  await database.close();
}
