// The identity module's public surface. Everything under src/internal is private to this module.
export {
  ACCOUNT_EMAIL,
  AccountEmailSender,
  accountEmail,
  type AccountEmail,
  type AccountEmailKind,
  type AccountEmailLanguage,
} from '../internal/account-emails.js';
export {
  SNS,
  feedbackOf,
  snsStringToSign,
  type EmailFeedback,
  type EmailFeedbackSettings,
  type SnsMessage,
} from '../internal/email-feedback.js';
export { AuthError, type AuthErrorCode } from '../internal/errors.js';
export { IdentityModule } from '../internal/identity.module.js';
export {
  IdentityService,
  LIFETIMES,
  RATE_LIMITS,
  TOKEN_PREFIX,
  normalizeEmail,
  type AccountEmails,
  type AuthenticatedSession,
  type ClientInfo,
  type GoogleConnection,
  type GoogleSignInResult,
  type IdentityServiceOptions,
  type OpenedShop,
  type PhoneSignInResult,
  type Reauthentication,
  type ReauthenticationMethod,
  type SecondFactorMethod,
  type SessionInfo,
  type SessionSummary,
  type SessionTokens,
  type ShopAccess,
  type SignInResult,
  type UserProfile,
} from '../internal/identity.service.js';
export {
  HaveIBeenPwnedChecker,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  noBreachCheck,
  type BreachedPasswordChecker,
} from '../internal/passwords.js';
export {
  PHONE_CODE,
  PhoneCodeSender,
  maskPhone,
  type PhoneCodeChannel,
  type PhoneCodeLanguage,
} from '../internal/phone-codes.js';
export { GOOGLE, type GoogleSignInSettings } from '../internal/google.js';
export { StaffAccessResolver, type StaffAccessResult } from '../internal/staff-access.js';
export {
  RESERVED_HANDLES,
  SHOP_LIMITS,
  ShopEvents,
  handleFrom,
  handleProblem,
  type ShopOpenedPayload,
} from '../internal/shops.js';
export { PASSKEY_LIMITS, type PasskeyInfo, type PasskeySettings } from '../internal/passkeys.js';
export { DEVICE_HEADER, SIGN_IN_ALERT } from '../internal/sign-in-alerts.js';
export {
  STAFF_LIMITS,
  StaffService,
  managedRoles,
  staffPhonesIn,
  type InvitationPreview,
  type StaffInvitationRecord,
  type StaffMemberRecord,
  type StaffPhoneRecord,
} from '../internal/staff.service.js';
export {
  SUPPORT_LIMITS,
  SupportAccessService,
  type SupportGrantRecord,
  type SupportShopRecord,
} from '../internal/support-access.service.js';
