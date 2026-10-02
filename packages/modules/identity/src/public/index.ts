// The identity module's public surface. Everything under src/internal is private to this module.
export { AuthError, type AuthErrorCode } from '../internal/errors.js';
export { IdentityModule } from '../internal/identity.module.js';
export {
  IdentityService,
  LIFETIMES,
  RATE_LIMITS,
  TOKEN_PREFIX,
  normalizeEmail,
  type AuthenticatedSession,
  type ClientInfo,
  type IdentityServiceOptions,
  type OpenedShop,
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
export {
  STAFF_LIMITS,
  StaffService,
  managedRoles,
  type InvitationPreview,
  type StaffInvitationRecord,
  type StaffMemberRecord,
} from '../internal/staff.service.js';
export {
  SUPPORT_LIMITS,
  SupportAccessService,
  type SupportGrantRecord,
  type SupportShopRecord,
} from '../internal/support-access.service.js';
