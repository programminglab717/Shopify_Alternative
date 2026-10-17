import { UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum FbrSystem {
  POS = 'POS',
  DIGITAL_INVOICING = 'DIGITAL_INVOICING',
}

registerEnumType(FbrSystem, {
  name: 'FbrSystem',
  description:
    "How a shop reports its invoices to FBR: POS, a Tier-1 retailer's POS reporting to FBR's " +
    "IMS (ADR-555); or DIGITAL_INVOICING, FBR's digital invoicing, for a seller registered for " +
    'sales tax (ADR-562).',
});

export enum FbrEnvironment {
  SANDBOX = 'SANDBOX',
  PRODUCTION = 'PRODUCTION',
}

registerEnumType(FbrEnvironment, {
  name: 'FbrEnvironment',
  description: "FBR's sandbox, to try a POS on, or the real one, where invoices count.",
});

export enum FiscalInvoiceKind {
  INVOICE = 'INVOICE',
  CREDIT_NOTE = 'CREDIT_NOTE',
}

registerEnumType(FiscalInvoiceKind, {
  name: 'FiscalInvoiceKind',
  description: 'An invoice, or a credit note correcting one (ADR-496).',
});

export enum FiscalInvoiceStatus {
  PENDING = 'PENDING',
  REPORTED = 'REPORTED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

registerEnumType(FiscalInvoiceStatus, {
  name: 'FiscalInvoiceStatus',
  description:
    'PENDING until FBR takes it, tried again while FBR cannot be reached; REPORTED with the ' +
    'number FBR gave it; FAILED when FBR refused it, saying why; SKIPPED when the shop ' +
    'disconnected FBR or switched how it reports before it went, or for a credit note, which ' +
    'digital invoicing takes none of.',
});

@ObjectType({
  description:
    "The shop's connection to FBR (POS-04, TAX-04, ADR-555, ADR-562): its POS as FBR registered " +
    "it, or FBR's digital invoicing. While it is connected, each invoice the shop issues is " +
    'reported to FBR, which gives it a number of its own, and each credit note, where FBR takes ' +
    'them: IMS does, digital invoicing does not.',
})
export class FbrPos {
  @Field(() => FbrSystem)
  system!: FbrSystem;

  @Field(() => Int, {
    nullable: true,
    description:
      'The POS ID FBR gave the POS when it registered it; null for digital invoicing, which has ' +
      'none.',
  })
  posId!: number | null;

  @Field({
    description:
      "The last four characters of its token, the POS's access token or the seller's security " +
      'token, never shown again.',
  })
  accessTokenHint!: string;

  @Field(() => FbrEnvironment)
  environment!: FbrEnvironment;

  @Field({
    description:
      'The PCT code, 8 digits, that items are reported under, until variants have codes of their ' +
      'own.',
  })
  pctCode!: string;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class FbrPosInput {
  @Field(() => FbrSystem, {
    nullable: true,
    description:
      'How the shop reports: POS unless given, connecting. DIGITAL_INVOICING needs the NTN, STRN ' +
      "and province in the shop's tax settings. Switching needs the other's token, and a POS ID " +
      'for a POS, and leaves those still waiting for the other unsent.',
  })
  system?: FbrSystem | null;

  @Field(() => Int, {
    nullable: true,
    description:
      'The POS ID FBR gave the POS: needed to connect a POS; none for digital invoicing.',
  })
  posId?: number | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The access token FBR gave for the POS, or the security token FBR issued the seller ' +
      'through IRIS for digital invoicing: needed to connect, kept sealed, and never shown again.',
  })
  accessToken?: string | null;

  @Field(() => FbrEnvironment, { nullable: true, description: 'Needed to connect.' })
  environment?: FbrEnvironment | null;

  @Field(() => String, {
    nullable: true,
    description: 'A PCT code from FBR\'s tariff, "6204.4200" or its 8 digits: needed to connect.',
  })
  pctCode?: string | null;
}

@ObjectType()
export class FbrPosUpdatePayload {
  @Field(() => FbrPos, { nullable: true })
  fbrPos!: FbrPos | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class FbrPosDeletePayload {
  @Field(() => FbrSystem, {
    nullable: true,
    description: 'How the shop reported; null when it was not connected.',
  })
  deletedSystem!: FbrSystem | null;

  @Field(() => Int, {
    nullable: true,
    description: 'The POS ID that was connected; null when none was, as for digital invoicing.',
  })
  deletedPosId!: number | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    'An invoice or credit note the shop issued while connected to FBR, and how reporting it to ' +
    'FBR went.',
})
export class FiscalInvoice {
  @Field(() => ID)
  id!: string;

  @Field(() => FbrSystem, { description: 'What it was kept for, and is sent to.' })
  system!: FbrSystem;

  @Field(() => FiscalInvoiceKind)
  kind!: FiscalInvoiceKind;

  @Field({ description: 'The shop\'s own number for it, FBR\'s USIN: "INV/2026-27/00001".' })
  usin!: string;

  @Field(() => ID, { description: 'The order it is of.' })
  orderId!: string;

  @Field(() => FiscalInvoiceStatus)
  status!: FiscalInvoiceStatus;

  @Field(() => String, {
    nullable: true,
    description: 'The number FBR gave it, once reported, which its printed copy shows.',
  })
  fbrInvoiceNumber!: string | null;

  @Field(() => Int, { description: 'How many times it was sent.' })
  attempts!: number;

  @Field(() => String, {
    nullable: true,
    description: 'Why it is not reported yet, or what FBR said refusing it.',
  })
  error!: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  reportedAt!: Date | null;

  @Field(() => GraphQLISODateTime, { description: 'When it was issued.' })
  createdAt!: Date;
}

@ArgsType()
export class FiscalInvoicesArgs {
  @Field(() => FiscalInvoiceStatus, { nullable: true, description: 'Those of this status alone.' })
  status?: FiscalInvoiceStatus | null;

  @Field(() => Int, { nullable: true, description: 'At most 100; 50 unless given.' })
  first?: number | null;
}

@ObjectType()
export class FiscalInvoiceRetryPayload {
  @Field(() => FiscalInvoice, { nullable: true })
  fiscalInvoice!: FiscalInvoice | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
