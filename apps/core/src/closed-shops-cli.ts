import { Database } from '@hatti/db';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { parseArgs } from 'node:util';
import { ClosedShopData, type ShopTable } from './closed-shops.js';
import { loadClosedShopsConfig } from './config.js';
import { workerStorage } from './storage.js';

// Closed shops whose data is due to go, 90 days after their owners closed them (ADR-741): each
// with what a purge deletes and what it keeps, and why. Until counsel has confirmed what is kept
// (OWN-41) and the worker's CLOSED_SHOP_PURGE is on, Hatti's people purge one by hand, with --yes,
// for deleting cannot be undone. For whoever runs Hatti, never through the Admin API.
//
//   pnpm --filter @hatti/core closed-shops list
//   pnpm --filter @hatti/core closed-shops purge shop_… --yes

const USAGE = 'Usage: closed-shops list\n       closed-shops purge <shop> --yes';

function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error(USAGE);
  process.exit(2);
}

let parsed: ReturnType<typeof parseCommand>;
try {
  parsed = parseCommand(process.argv.slice(2));
} catch (error) {
  usage((error as Error).message);
}

const config = loadClosedShopsConfig();
const database = new Database({
  appUrl: config.DATABASE_URL,
  systemUrl: config.DATABASE_SYSTEM_URL,
  applicationName: 'closed-shops',
});
const data = new ClosedShopData(database, workerStorage(config));
try {
  if (parsed.command === 'list') {
    const due = await data.due(new Date(), 100);
    if (due.length === 0) console.log("No closed shop's data is due to go.");
    for (const shop of due) {
      console.log(`${toPublicId('shop', shop.id)}\t${shop.closedAt.toISOString()}\t${shop.name}`);
      for (const table of await data.report(shop.id)) console.log(`  ${tableLine(table)}`);
    }
  } else {
    const purged = await data.purge(parsed.shop);
    if (!purged) {
      console.error(`${parsed.id} is not a closed shop whose data is due to go: see the list.`);
      process.exitCode = 1;
    } else {
      for (const [table, rows] of Object.entries(purged.deleted)) {
        console.log(`deleted\t${table}\t${rows}`);
      }
      if (purged.blocked.length > 0) {
        console.error(`Not deleted, as other rows still name theirs: ${purged.blocked.join(', ')}`);
        process.exitCode = 1;
      } else {
        console.log(`${parsed.id}'s data is deleted, but the records kept, and its files.`);
      }
    }
  }
} finally {
  await database.close();
}

/** The command line, checked: what to do, and with which shop. */
function parseCommand(
  args: string[],
): { command: 'list' } | { command: 'purge'; id: string; shop: string } {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { yes: { type: 'boolean' } },
  });
  const [command, id, ...rest] = positionals;
  if (rest.length > 0) throw new Error(`Unexpected: ${rest.join(' ')}`);
  if (command === 'list') {
    if (id) throw new Error(`Unexpected: ${id}`);
    return { command };
  }
  if (command !== 'purge') throw new Error('Say what to do');
  if (!id) throw new Error('Name the shop, as the list shows it');
  if (!values.yes) throw new Error('Deleting cannot be undone: say --yes');
  // As the list shows it, or as the database keeps it.
  return { command, id, shop: tryFromPublicId(id, 'shop') ?? id };
}

/** A table of the shop's on one line: its rows, and kept with why, or deleted. */
function tableLine(table: ShopTable): string {
  return [table.table, table.rows, table.kept ? `kept: ${table.kept}` : 'deleted'].join('\t');
}
