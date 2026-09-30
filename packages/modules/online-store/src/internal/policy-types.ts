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

/** Each policy's title, in English, as the Admin API gives it. */
export const POLICY_TITLES: Readonly<Record<PolicyType, string>> = {
  refund_policy: 'Refund policy',
  privacy_policy: 'Privacy policy',
  terms_of_service: 'Terms of service',
  shipping_policy: 'Shipping policy',
  contact_information: 'Contact information',
};

/** Where the storefront shows it: refund_policy at /policies/refund-policy. */
export function policyHandle(type: PolicyType): string {
  return type.replace(/_/g, '-');
}
