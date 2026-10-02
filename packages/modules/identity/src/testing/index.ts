// Test helpers for the identity module's passkeys, Google sign-in and SES's feedback. Not for
// production code.
export { GoogleTestIssuer, type GoogleTestClaims } from './google-issuer.js';
export { SnsTestTopic } from './sns-topic.js';
export { SoftAuthenticator } from './soft-authenticator.js';
