/**
 * A shop's policies, as Shopify names them (ADR-056): each once, shown at /policies/{handle}, in
 * this order.
 */
export const POLICY_TYPES = [
  'refund_policy',
  'privacy_policy',
  'terms_of_service',
  'shipping_policy',
  'contact_information',
] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

/** The languages policies' titles and drafts are in. */
export type PolicyLocale = 'en' | 'ur';

/**
 * Each policy's title: in English, as the Admin API gives it, and in Urdu, as drafts and the
 * checkout's links give it.
 */
export const POLICY_TITLES: Readonly<Record<PolicyType, Readonly<Record<PolicyLocale, string>>>> = {
  refund_policy: { en: 'Refund policy', ur: 'واپسی کی پالیسی' },
  privacy_policy: { en: 'Privacy policy', ur: 'رازداری کی پالیسی' },
  terms_of_service: { en: 'Terms of service', ur: 'شرائط و ضوابط' },
  shipping_policy: { en: 'Shipping policy', ur: 'ترسیل کی پالیسی' },
  contact_information: { en: 'Contact information', ur: 'رابطے کی معلومات' },
};

/** Where the storefront shows it: refund_policy at /policies/refund-policy. */
export function policyHandle(type: PolicyType): string {
  return type.replace(/_/g, '-');
}
