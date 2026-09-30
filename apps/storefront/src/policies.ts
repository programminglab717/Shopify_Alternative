// A shop's policies (ADR-056), as Shopify names them and shows them at /policies/{handle}, in the
// layout of the shop's theme around markup of Shopify's own, which themes style.

export interface PolicyKind {
  type: string;
  handle: string;
  /** In each language the storefront speaks. */
  title: Readonly<Record<string, string>>;
}

/** In Shopify's order, as footers list them. */
export const POLICIES: readonly PolicyKind[] = [
  {
    type: 'refund_policy',
    handle: 'refund-policy',
    title: { en: 'Refund policy', ur: 'واپسی کی پالیسی' },
  },
  {
    type: 'privacy_policy',
    handle: 'privacy-policy',
    title: { en: 'Privacy policy', ur: 'رازداری کی پالیسی' },
  },
  {
    type: 'terms_of_service',
    handle: 'terms-of-service',
    title: { en: 'Terms of service', ur: 'شرائط و ضوابط' },
  },
  {
    type: 'shipping_policy',
    handle: 'shipping-policy',
    title: { en: 'Shipping policy', ur: 'ترسیل کی پالیسی' },
  },
  {
    type: 'contact_information',
    handle: 'contact-information',
    title: { en: 'Contact information', ur: 'رابطے کی معلومات' },
  },
];

export function policyByHandle(handle: string): PolicyKind | null {
  return POLICIES.find((policy) => policy.handle === handle) ?? null;
}

export function policyTitle(policy: PolicyKind, locale: string): string {
  return policy.title[locale] ?? policy.title.en!;
}

/**
 * A policy's page, as Shopify writes it: its title and its body, which the online store cleaned
 * when it was saved.
 */
export function policyMarkup(title: string, body: string): string {
  return (
    '<div class="shopify-policy__container">' +
    `<div class="shopify-policy__title"><h1>${escapeText(title)}</h1></div>` +
    `<div class="shopify-policy__body"><div class="rte" dir="auto">${body}</div></div>` +
    '</div>'
  );
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
