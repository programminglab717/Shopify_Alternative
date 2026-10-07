import { Database } from '@hatti/db';
import { CourierCityReview, SHARED_CITY_SHOPS } from '@hatti/logistics/public';
import { loadCourierCitiesConfig } from './config.js';

// Couriers' names for cities across shops (ADR-260), for Hatti's own people, by whoever runs
// Hatti, never through the Admin API: the names shops gave each city, how many gave each, and
// those shared because enough shops agree; and Hatti's own names, which come first, kept to settle
// a city shops named wrong, or forgotten.
//
//   pnpm --filter @hatti/core courier-cities list postex
//   pnpm --filter @hatti/core courier-cities keep postex "Chak 45" "CHAK 45 SB"
//   pnpm --filter @hatti/core courier-cities forget postex "Chak 45"

const USAGE =
  'Usage: courier-cities list <courier>\n' +
  "       courier-cities keep <courier> <city> <courier's name for it>\n" +
  '       courier-cities forget <courier> <city>';

const [command, courier, city, courierCity] = process.argv.slice(2);
const wanted = { list: 2, keep: 4, forget: 3 }[command ?? ''];
if (wanted === undefined || process.argv.length - 2 !== wanted) {
  console.error(USAGE);
  process.exit(2);
}

const config = loadCourierCitiesConfig();
const database = new Database({
  appUrl: config.DATABASE_URL,
  systemUrl: config.DATABASE_SYSTEM_URL,
  applicationName: 'courier-cities',
});
const review = new CourierCityReview(database);
try {
  if (command === 'list') {
    const { shops, hatti } = await review.review(courier!);
    console.log(`Hatti's names with ${courier}, which come first:`);
    if (hatti.length === 0) console.log('  none');
    for (const name of hatti) console.log(`  ${name.city}\t${name.courierCity}`);
    console.log(
      `Shops' names with ${courier}, shared where ${SHARED_CITY_SHOPS} shops or more agree:`,
    );
    if (shops.length === 0) console.log('  none');
    for (const entry of shops) {
      const names = entry.names.map((name) => `${name.courierCity} (${name.shops})`).join(', ');
      const state = entry.shared ? 'shared' : entry.names.length > 1 ? 'disputed' : 'not yet';
      console.log(`  ${entry.city}\t${names}\t${state}`);
    }
  } else if (command === 'keep') {
    await review.keep(courier!, city!, courierCity!);
    console.log(`Every shop's parcels to ${city} go to ${courier} as ${courierCity}.`);
  } else {
    const forgotten = await review.forget(courier!, city!);
    console.log(
      forgotten
        ? `Hatti no longer names ${city} with ${courier}.`
        : `Hatti had no name for ${city} with ${courier}.`,
    );
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await database.close();
}
