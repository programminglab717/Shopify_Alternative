import { S3Storage } from '@hatti/storage';
import { loadStorageCorsConfig } from './config.js';
import { storageCorsRules } from './storage.js';

// The bucket's CORS rule (ADR-733), set by whoever runs Hatti once the bucket and the admin's
// address are known, and again if the admin moves: without it, browsers refuse the admin's
// uploads straight to the bucket (ADR-268). "show" compares the bucket's rules with the rule
// Hatti needs; "apply" puts that rule in their place.
//
//   pnpm --filter @hatti/core storage-cors show
//   pnpm --filter @hatti/core storage-cors apply

const [command] = process.argv.slice(2);
if (command !== 'show' && command !== 'apply') {
  console.error('Usage: storage-cors show|apply');
  process.exit(2);
}

const config = loadStorageCorsConfig();
const bucket = new S3Storage({
  endpoint: config.S3_ENDPOINT!,
  bucket: config.S3_BUCKET!,
  region: config.S3_REGION,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY_ID!,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
  },
});
const wanted = storageCorsRules(config.ADMIN_URL);
const current = await bucket.cors();
const same = JSON.stringify(current) === JSON.stringify(wanted);

if (command === 'show') {
  console.log(
    `${config.S3_BUCKET} has: ${current ? JSON.stringify(current, null, 2) : 'no rules'}`,
  );
  console.log(
    same ? 'That is the rule Hatti needs.' : `Hatti needs: ${JSON.stringify(wanted, null, 2)}`,
  );
  if (!same) process.exitCode = 1;
} else if (same) {
  console.log(`${config.S3_BUCKET} has the rule Hatti needs already.`);
} else {
  await bucket.setCors(wanted);
  console.log(`${config.S3_BUCKET} lets ${wanted[0]!.origins[0]} upload and read its files.`);
}
