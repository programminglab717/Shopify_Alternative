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
  liftSuppression,
  snsStringToSign,
  suppressionOf,
  type EmailFeedback,
  type EmailFeedbackSettings,
  type EmailSuppressionRecord,
  type SesSuppressionList,
  type SnsMessage,
  type SuppressionLift,
} from '../internal/email-feedback.js';
export {
  CUSTOM_ROLE_LIMITS,
  type CustomRoleCreateInput,
  type CustomRoleRecord,
  type CustomRoleUpdateInput,
  type StaffRoleChoice,
} from '../internal/custom-roles.js';
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
  type ClosedShop,
  type MemberShop,
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
  CLOSED_SHOP_DAYS,
  RESERVED_HANDLES,
  SHOP_LIMITS,
  ShopEvents,
  handleFrom,
  handleProblem,
  type ShopClosedPayload,
  type ShopOpenedPayload,
} from '../internal/shops.js';
export {
  PARTNER_APP_LIMITS,
  PartnerAppsService,
  type AppConsent,
  type PartnerAppInput,
  type PartnerAppRecord,
  type RedeemedAuthorization,
} from '../internal/partner-apps.service.js';
export {
  PartnerThemesService,
  THEME_STORE_LIMITS,
  type ThemeListingRecord,
  type ThemeOffer,
} from '../internal/partner-themes.service.js';
export {
  EXPERT_LIMITS,
  EXPERT_SERVICES,
  ExpertsService,
  type EnquiryRecord,
  type ExpertProfileInput,
  type ExpertRecord,
  type ExpertService,
} from '../internal/experts.service.js';
export {
  CERTIFICATION_LIMITS,
  CertificationService,
  type AttemptResult,
  type CertificateRecord,
  type CourseView,
} from '../internal/certification.service.js';
export {
  PARTNER_LIMITS,
  PartnersService,
  recordAppSale,
  recordPartnerEarning,
  recordThemeSale,
  type PartnerEarnings,
  type PartnerOwed,
  type PartnerProfile,
  type PartnerStore,
  type PartnerStoreKind,
} from '../internal/partners.service.js';
export { PASSKEY_LIMITS, type PasskeyInfo, type PasskeySettings } from '../internal/passkeys.js';
export { DEVICE_HEADER, SIGN_IN_ALERT } from '../internal/sign-in-alerts.js';
export {
  STAFF_LIMITS,
  StaffService,
  endExpiredMemberships,
  managedRoles,
  ownerEmailIn,
  staffOfPhone,
  staffPhonesIn,
  type AccessRequestRecord,
  type CustomRoleName,
  type InvitationPreview,
  type OwnerEmailRecord,
  type StaffInvitationRecord,
  type StaffMemberRecord,
  type StaffOfPhoneRecord,
  type StaffPhoneRecord,
} from '../internal/staff.service.js';
export {
  SUPPORT_LIMITS,
  SupportAccessService,
  type SupportGrantRecord,
  type SupportShopRecord,
} from '../internal/support-access.service.js';
