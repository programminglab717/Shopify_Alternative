import { registerEnumType } from '@nestjs/graphql';

/** The language AI copy is written in, as the Admin API names it (ADR-471, ADR-801). */
export enum CopyLanguage {
  ENGLISH = 'ENGLISH',
  URDU = 'URDU',
  ROMAN_URDU = 'ROMAN_URDU',
}

registerEnumType(CopyLanguage, {
  name: 'CopyLanguage',
  description:
    'The language AI copy is written in: English, Urdu in its own script, or Roman Urdu, Urdu ' +
    'in Latin letters as shoppers write it on WhatsApp.',
});

/** Each language as the AI package names it. */
export const COPY_LANGUAGE = {
  [CopyLanguage.ENGLISH]: 'en',
  [CopyLanguage.URDU]: 'ur',
  [CopyLanguage.ROMAN_URDU]: 'roman_ur',
} as const;
