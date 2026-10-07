import { UserError } from '@hatti/api';
import { Field, GraphQLISODateTime, ID, InputType, ObjectType } from '@nestjs/graphql';

@ObjectType('Domain', {
  description:
    "A domain of the shop's own, such as www.zari.pk, beside its address on the platform's " +
    'domain. The storefront answers at it once DNS points it at the platform (ADR-048).',
})
export class OnlineStoreDomain {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'As DNS has it, lowercase: www.zari.pk.' })
  host!: string;

  @Field({ description: "The storefront's address at the domain: https://www.zari.pk." })
  url!: string;

  @Field({
    description:
      'Whether DNS pointed it at the platform when it was checked: the storefront answers at it ' +
      'from then on.',
  })
  isVerified!: boolean;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When DNS last pointed it at the platform; null until it has.',
  })
  verifiedAt!: Date | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description:
      'Since when DNS has pointed it elsewhere, as Hatti found checking it again every few hours; ' +
      'null while it points at the platform. The shop is told, and three days on a verified ' +
      'domain is disconnected: verified no more, nor primary (ADR-262).',
  })
  unpointedSince!: Date | null;

  @Field({
    description:
      "Where the storefront sends shoppers: one of the shop's verified domains at most. Without " +
      "one, the shop's address on the platform's domain is.",
  })
  isPrimary!: boolean;

  @Field({
    description:
      'Where to point the domain: a CNAME record naming this host, or, at the apex of a domain ' +
      "whose DNS provider flattens CNAME records, one flattened to this host's addresses.",
  })
  dnsTarget!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType({ description: 'A domain to connect.' })
export class DomainCreateInput {
  @Field({ description: 'The domain, such as www.zarifashions.pk; a copied address will do.' })
  host!: string;
}

@InputType({ description: 'Changes to a domain: fields left out stay as they are.' })
export class DomainUpdateInput {
  @Field(() => Boolean, {
    nullable: true,
    description:
      'Makes it the primary domain, which it must be verified and still pointed at the platform ' +
      'to be, or primary no more. The domain primary until then stops being.',
  })
  isPrimary?: boolean | null;
}

@ObjectType()
export class DomainPayload {
  @Field(() => OnlineStoreDomain, { nullable: true })
  domain!: OnlineStoreDomain | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DomainDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedDomainId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
