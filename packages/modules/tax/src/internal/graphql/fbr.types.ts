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
    'disconnected FBR before it went.',
});

@ObjectType({
  description:
    "The shop's POS as FBR registered it (POS-04, TAX-04, ADR-555): while it is connected, each " +
    'invoice and credit note the shop issues is reported to FBR, which gives it a number of its ' +
    'own.',
})
export class FbrPos {
  @Field(() => Int, { description: 'The POS ID FBR gave the POS when it registered it.' })
  posId!: number;

  @Field({ description: 'The last four characters of its access token, never shown again.' })
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
  @Field(() => Int, {
    nullable: true,
    description: 'The POS ID FBR gave the POS: needed to connect.',
  })
  posId?: number | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The access token FBR gave for the POS: needed to connect, kept sealed, and never shown ' +
      'again.',
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
  @Field(() => Int, {
    nullable: true,
    description: 'The POS ID that was connected; null when none was.',
  })
  deletedPosId!: number | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    'An invoice or credit note the shop issued while its POS was connected, and how reporting ' +
    'it to FBR went.',
})
export class FiscalInvoice {
  @Field(() => ID)
  id!: string;

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
