import { registerEnumType } from '@nestjs/graphql';

/** GraphQL enums of printed documents, shared by every module that prints one. */
export enum PaperSize {
  A4 = 'A4',
  THERMAL_4X6 = 'THERMAL_4X6',
  THERMAL_80MM = 'THERMAL_80MM',
}

registerEnumType(PaperSize, {
  name: 'PaperSize',
  description: 'The paper a document is set up for.',
  valuesMap: {
    A4: { description: 'A4 sheets.' },
    THERMAL_4X6: { description: '4×6 inch thermal labels, the size of courier labels.' },
    THERMAL_80MM: { description: 'An 80 mm thermal receipt roll, cut after each order.' },
  },
});

export enum DocumentLanguage {
  BILINGUAL = 'BILINGUAL',
  ENGLISH = 'ENGLISH',
  URDU = 'URDU',
}

registerEnumType(DocumentLanguage, {
  name: 'DocumentLanguage',
  description: "A document's wording. Names, addresses and products stay as they were typed.",
  valuesMap: {
    BILINGUAL: { description: 'English, with the Urdu after it.' },
    ENGLISH: { description: 'English only.' },
    URDU: { description: 'Urdu only, right to left.' },
  },
});
