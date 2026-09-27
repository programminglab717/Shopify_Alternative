import type { CreateProductInput } from '@hatti/catalog/public';

/** A small, realistic Pakistani catalogue for local development and demos. */
export const SAMPLE_PRODUCTS: CreateProductInput[] = [
  {
    title: 'Lawn 3-Piece Suit (Unstitched)',
    status: 'active',
    vendor: 'Bazaar Textiles',
    productType: 'Unstitched',
    tags: ['lawn', 'summer', 'women'],
    description: 'Printed lawn shirt, dyed trouser and chiffon dupatta.',
    variants: [{ price: '4,990', compareAtPrice: '6,500', sku: 'LAWN-3PC-01' }],
  },
  {
    title: 'Peshawari Chappal',
    status: 'active',
    vendor: 'Qissa Khwani Footwear',
    productType: 'Footwear',
    tags: ['chappal', 'men', 'leather'],
    variants: [
      { title: 'Size 8', price: '3,499', sku: 'PC-08' },
      { title: 'Size 9', price: '3,499', sku: 'PC-09' },
      { title: 'Size 10', price: '3,699', sku: 'PC-10' },
    ],
  },
  {
    title: 'Multani Khussa',
    status: 'active',
    vendor: 'Multan Craft House',
    productType: 'Footwear',
    tags: ['khussa', 'wedding', 'women'],
    variants: [
      { title: 'Size 37', price: '2,250' },
      { title: 'Size 38', price: '2,250' },
    ],
  },
  {
    title: 'Shalwar Qameez, Wash & Wear',
    status: 'active',
    vendor: 'Bazaar Textiles',
    productType: 'Stitched',
    tags: ['men', 'eid', 'کرتا شلوار'],
    variants: [
      { title: 'M', price: '3,200' },
      { title: 'L', price: '3,200' },
      { title: 'XL', price: '3,400' },
    ],
  },
  {
    title: 'Sindhi Ajrak',
    status: 'active',
    vendor: 'Hala Block Prints',
    productType: 'Accessories',
    tags: ['ajrak', 'sindh', 'gift'],
    variants: [{ price: '1,850' }],
  },
  {
    title: 'Kashmiri Pashmina Shawl',
    status: 'draft',
    vendor: 'Neelum Looms',
    productType: 'Accessories',
    tags: ['shawl', 'winter'],
    variants: [{ price: '12,500', compareAtPrice: '15,000' }],
  },
];
