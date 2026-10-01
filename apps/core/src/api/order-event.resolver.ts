import { Loaders, RequestLoaders } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { StaffService } from '@hatti/identity/public';
import { OrderEvent } from '@hatti/orders/public';
import {
  Field,
  ID,
  ObjectType,
  Parent,
  ResolveField,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';

export enum OrderEventAuthorKind {
  STAFF = 'STAFF',
  APP = 'APP',
}

registerEnumType(OrderEventAuthorKind, {
  name: 'OrderEventAuthorKind',
  description: "Who made an entry of an order's timeline: a member of staff, or an app.",
});

@ObjectType({
  description:
    "Who made an entry of an order's timeline, or wrote its comment (ADR-128): who they are, " +
    'not how they sign in.',
})
export class OrderEventAuthor {
  @Field(() => OrderEventAuthorKind)
  kind!: OrderEventAuthorKind;

  @Field(() => ID, {
    description: "A member of staff's account (usr_…), or an app's access token (tok_…).",
  })
  id!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "A member of staff's name, as their account has it now, though they may have left the " +
      'shop since; null for apps.',
  })
  name!: string | null;
}

/**
 * Who made each entry of an order's timeline (ADR-128): the orders module keeps the actor's
 * account or token, and the core asks the identity module their names, once for a page of
 * entries.
 */
@Resolver(() => OrderEvent)
export class OrderEventResolver {
  constructor(private readonly staff: StaffService) {}

  @ResolveField(() => OrderEventAuthor, {
    nullable: true,
    description:
      "Who made it, or wrote it; null for what the shop's customers did through their links, " +
      'and what the platform did by itself.',
  })
  async author(
    @Loaders() loaders: RequestLoaders,
    @Parent() event: OrderEvent,
  ): Promise<OrderEventAuthor | null> {
    if (event.actorKind === 'system' || !event.actorId) return null;
    if (event.actorKind === 'app') {
      return Object.assign(new OrderEventAuthor(), {
        kind: OrderEventAuthorKind.APP,
        id: toPublicId('accessToken', event.actorId),
        name: null,
      });
    }
    const loader = loaders.get<string, string>('identity.names', (ids) => this.staff.namesOf(ids));
    return Object.assign(new OrderEventAuthor(), {
      kind: OrderEventAuthorKind.STAFF,
      id: toPublicId('user', event.actorId),
      name: (await loader.load(event.actorId)) ?? null,
    });
  }
}
