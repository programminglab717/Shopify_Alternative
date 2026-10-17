import { generateVapidKeys } from '@hatti/messaging/public';

// Makes Hatti a VAPID key pair (ADR-506), which pushes to staff's browsers are signed with, for
// whoever runs Hatti to put in the API's and the worker's environment once. Changing the keys
// later drops every browser's subscription: browsers subscribed with the old public key.
//
//   pnpm --filter @hatti/core vapid-keys

const { publicKey, privateKey } = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:push@hatti.pk');
