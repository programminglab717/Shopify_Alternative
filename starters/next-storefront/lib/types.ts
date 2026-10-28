// What the storefront's queries answer, as lib/queries.ts asks for it.

export interface Money {
  amount: string;
  currencyCode: string;
}

export interface Picture {
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
}

export interface ProductCard {
  id: string;
  handle: string;
  title: string;
  availableForSale: boolean;
  featuredImage: Picture | null;
  priceRange: { minVariantPrice: Money };
}

export interface Variant {
  id: string;
  title: string;
  availableForSale: boolean;
  price: Money;
  compareAtPrice: Money | null;
  selectedOptions: { name: string; value: string }[];
}

export interface Product {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string;
  availableForSale: boolean;
  options: { name: string; values: string[] }[];
  images: { nodes: Picture[] };
  variants: { nodes: Variant[] };
}

export interface CartLine {
  id: string;
  quantity: number;
  merchandise: {
    id: string;
    title: string;
    product: { handle: string; title: string };
    image: Picture | null;
  };
  cost: { totalAmount: Money };
}

export interface Cart {
  id: string;
  checkoutUrl: string;
  totalQuantity: number;
  cost: { subtotalAmount: Money; totalAmount: Money };
  lines: { nodes: CartLine[] };
}
