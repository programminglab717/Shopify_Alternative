import { UserError } from '@hatti/api';
import {
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { MessageLanguage } from './messaging.types.js';

export enum WhatsAppTemplateStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  PAUSED = 'PAUSED',
  DISABLED = 'DISABLED',
}

registerEnumType(WhatsAppTemplateStatus, {
  name: 'WhatsAppTemplateStatus',
  description: "How Meta stands on one of the shop's templates (ADR-420).",
  valuesMap: {
    PENDING: { description: 'Meta is reviewing it, within a day as a rule.' },
    APPROVED: { description: 'It can be sent.' },
    REJECTED: { description: 'Meta refused it: rejectedReason says why, where Meta does.' },
    PAUSED: { description: "Meta stopped it for a while, for customers' blocks and reports." },
    DISABLED: { description: 'Meta stopped it for good, or it is being deleted.' },
  },
});

@ObjectType({
  description:
    'A marketing template the shop wrote for its own WhatsApp number (MKT-01, ADR-420), sent to ' +
    'Meta for approval: what broadcasts send.',
})
export class WhatsAppTemplate {
  @Field(() => ID)
  id!: string;

  @Field({ description: "Meta's name for it: lowercase letters, digits and underscores." })
  name!: string;

  @Field(() => MessageLanguage)
  language!: MessageLanguage;

  @Field(() => String, { nullable: true, description: 'A line above the body, in bold.' })
  header!: string | null;

  @Field({ description: "Its words; {{1}}, if anywhere, is the customer's first name." })
  body!: string;

  @Field(() => String, { nullable: true, description: 'A line below the body, in grey.' })
  footer!: string | null;

  @Field(() => String, { nullable: true, description: "A button's words, opening buttonUrl." })
  buttonText!: string | null;

  @Field(() => String, { nullable: true })
  buttonUrl!: string | null;

  @Field(() => WhatsAppTemplateStatus)
  status!: WhatsAppTemplateStatus;

  @Field(() => String, {
    nullable: true,
    description: 'Why Meta rejected, paused or disabled it, in its words, where it says.',
  })
  rejectedReason!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class WhatsAppTemplateInput {
  @Field({ description: 'Lowercase letters, digits and underscores: "eid_sale".' })
  name!: string;

  @Field(() => MessageLanguage)
  language!: MessageLanguage;

  @Field(() => String, { nullable: true })
  header?: string | null;

  @Field()
  body!: string;

  @Field(() => String, { nullable: true })
  footer?: string | null;

  @Field(() => String, { nullable: true })
  buttonText?: string | null;

  @Field(() => String, { nullable: true, description: 'An https:// address.' })
  buttonUrl?: string | null;
}

@ObjectType()
export class WhatsAppTemplateCreatePayload {
  @Field(() => WhatsAppTemplate, { nullable: true })
  whatsAppTemplate!: WhatsAppTemplate | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class WhatsAppTemplateDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedWhatsAppTemplateId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class WhatsAppTemplatesSyncPayload {
  @Field(() => [WhatsAppTemplate])
  whatsAppTemplates!: WhatsAppTemplate[];

  @Field(() => [UserError])
  userErrors!: UserError[];
}
