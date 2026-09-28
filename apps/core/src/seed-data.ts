import type { CreateCollectionInput, CreateProductInput } from '@hatti/catalog/public';

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
    options: [{ name: 'Size', values: ['8', '9', '10'] }],
    variants: [
      { optionValues: ['8'], price: '3,499', cost: '1,950', sku: 'PC-08', weightGrams: 900 },
      { optionValues: ['9'], price: '3,499', cost: '1,950', sku: 'PC-09', weightGrams: 950 },
      { optionValues: ['10'], price: '3,699', cost: '2,050', sku: 'PC-10', weightGrams: 1000 },
    ],
  },
  {
    title: 'Multani Khussa',
    status: 'active',
    vendor: 'Multan Craft House',
    productType: 'Footwear',
    tags: ['khussa', 'wedding', 'women'],
    options: [
      { name: 'Size', values: ['37', '38'] },
      { name: 'Colour', values: ['Gold', 'Silver'] },
    ],
    variants: [
      { optionValues: ['37', 'Gold'], price: '2,250' },
      { optionValues: ['38', 'Gold'], price: '2,250' },
      { optionValues: ['38', 'Silver'], price: '2,350' },
    ],
  },
  {
    title: 'Shalwar Qameez, Wash & Wear',
    status: 'active',
    vendor: 'Bazaar Textiles',
    productType: 'Stitched',
    tags: ['men', 'eid', 'کرتا شلوار'],
    options: [{ name: 'Size', values: ['M', 'L', 'XL'] }],
    variants: [
      { optionValues: ['M'], price: '3,200' },
      { optionValues: ['L'], price: '3,200' },
      { optionValues: ['XL'], price: '3,400' },
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

/** Smart collections over the sample catalogue; they fill themselves from the rules. */
export const SAMPLE_COLLECTIONS: CreateCollectionInput[] = [
  {
    title: 'Footwear',
    sortOrder: 'price_asc',
    ruleSet: {
      appliedDisjunctively: false,
      rules: [{ column: 'type', relation: 'equals', condition: 'Footwear' }],
    },
  },
  {
    title: 'Eid Edit',
    ruleSet: {
      appliedDisjunctively: true,
      rules: [
        { column: 'tag', relation: 'equals', condition: 'eid' },
        { column: 'tag', relation: 'equals', condition: 'wedding' },
      ],
    },
  },
];
