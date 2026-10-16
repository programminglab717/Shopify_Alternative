import {
  CurrentTenant,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  deniedToRole,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import {
  VERIFICATION_LIMITS,
  VerificationsService,
  type VerificationRecord,
} from '../verifications.service.js';

export enum VerificationLevel {
  IDENTITY = 'IDENTITY',
  BUSINESS = 'BUSINESS',
}

registerEnumType(VerificationLevel, {
  name: 'VerificationLevel',
  description: 'What Hatti verifies of a shop (ONB-11, ADR-465).',
  valuesMap: {
    IDENTITY: { description: 'Who runs it: its owner, by their CNIC.' },
    BUSINESS: { description: 'The business, by its NTN, once its owner is verified.' },
  },
});

export enum VerificationStatus {
  WAITING = 'WAITING',
  APPROVED = 'APPROVED',
  REFUSED = 'REFUSED',
  REVOKED = 'REVOKED',
}

registerEnumType(VerificationStatus, {
  name: 'VerificationStatus',
  description:
    "WAITING for Hatti's people, APPROVED, REFUSED with why, or REVOKED: taken back, with why.",
});

@ObjectType({ description: 'A request for Hatti to verify the shop at a level.' })
export class VerificationRequest {
  @Field(() => ID)
  id!: string;

  @Field(() => VerificationLevel)
  level!: VerificationLevel;

  @Field({ description: "The name on the CNIC, or the business's registered name." })
  name!: string;

  @Field(() => String, { nullable: true, description: "The CNIC's last four digits alone." })
  cnicLast4!: string | null;

  @Field(() => String, { nullable: true })
  ntn!: string | null;

  @Field(() => VerificationStatus)
  status!: VerificationStatus;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  decidedAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description: 'Why Hatti refused it or took it back, or a note on its approval.',
  })
  answer!: string | null;
}

@ObjectType({ description: "The shop's verification by Hatti (ONB-11, ADR-465)." })
export class ShopVerification {
  @Field(() => VerificationLevel, {
    nullable: true,
    description:
      'What Hatti verified and stands by: BUSINESS, which needs its owner verified too, IDENTITY, ' +
      'or none. Its storefront shows a shop verified as such.',
  })
  level!: VerificationLevel | null;

  @Field(() => [VerificationRequest], {
    description: `Its latest ${VERIFICATION_LIMITS.listed} requests, the newest first.`,
  })
  requests!: VerificationRequest[];
}

@InputType()
export class ShopVerificationInput {
  @Field(() => VerificationLevel)
  level!: VerificationLevel;

  @Field({ description: "The name on the owner's CNIC, or the business's registered name." })
  name!: string;

  @Field(() => String, {
    nullable: true,
    description: "For IDENTITY: the owner's CNIC, like 35202-1234567-1.",
  })
  cnic?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      "For BUSINESS: the NTN as FBR wrote it, like 1234567-8, or a sole proprietor's CNIC.",
  })
  ntn?: string | null;

  @Field(() => [String], {
    description:
      `One to ${VERIFICATION_LIMITS.documents} staged uploads' resourceUrls: photos of the CNIC's ` +
      'two sides, or the NTN certificate. Deleted once Hatti decides.',
  })
  documents!: string[];
}

@ObjectType()
export class ShopVerificationSubmitPayload {
  @Field(() => VerificationRequest, { nullable: true })
  request!: VerificationRequest | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/** Owners and managers see it; the owner alone asks. */
function staff(tenant: TenantContext, owner: boolean): void {
  if (
    tenant.actor.kind !== 'staff' ||
    (tenant.actor.role !== 'owner' && (owner || tenant.actor.role !== 'manager'))
  ) {
    throw deniedToRole(
      owner
        ? "Access denied. Only the shop's owner asks Hatti to verify it."
        : "Access denied. Only the shop's owner and managers see its verification.",
    );
  }
}

/** The shop's verification by Hatti (ONB-11, ADR-465). */
@Resolver(() => ShopVerification)
export class VerificationResolver {
  constructor(private readonly service: VerificationsService) {}

  @Query(() => ShopVerification, {
    description: "The shop's verification by Hatti: its level, and its requests.",
  })
  @RequireScopes('read_settings')
  async shopVerification(@CurrentTenant() tenant: TenantContext): Promise<ShopVerification> {
    staff(tenant, false);
    const status = await this.service.status(tenant);
    return Object.assign(new ShopVerification(), {
      level: status.level ? (status.level.toUpperCase() as VerificationLevel) : null,
      requests: status.requests.map(toRequest),
    });
  }

  @Mutation(() => ShopVerificationSubmitPayload, {
    description:
      "Asks Hatti to verify the shop's owner, by their CNIC, or then the business, by its NTN, " +
      "with photos of the documents. Hatti's people decide, usually within two working days; " +
      'the documents are deleted once they do, and the CNIC kept as its last four digits. One ' +
      "request waits at a time. The owner's alone, who must have proved who they are lately.",
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async shopVerificationSubmit(
    @CurrentTenant() tenant: TenantContext,
    @Args('input', { type: () => ShopVerificationInput }) input: ShopVerificationInput,
  ): Promise<ShopVerificationSubmitPayload> {
    staff(tenant, true);
    const result = await this.service.submit(
      tenant,
      {
        level: input.level === VerificationLevel.BUSINESS ? 'business' : 'identity',
        name: input.name,
        cnic: input.cnic,
        ntn: input.ntn,
        documents: input.documents,
      },
      tenant.actor.kind === 'staff' ? tenant.actor.userId : '',
    );
    return Object.assign(new ShopVerificationSubmitPayload(), {
      request: result.ok ? toRequest(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toRequest(record: VerificationRecord): VerificationRequest {
  return Object.assign(new VerificationRequest(), {
    id: toPublicId('verification', record.id),
    level: record.level.toUpperCase() as VerificationLevel,
    name: record.name,
    cnicLast4: record.cnicLast4,
    ntn: record.ntn,
    status: record.status.toUpperCase() as VerificationStatus,
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
    answer: record.answer,
  });
}
