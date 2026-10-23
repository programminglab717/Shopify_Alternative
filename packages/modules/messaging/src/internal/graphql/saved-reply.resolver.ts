import { CurrentTenant, RequireScopes, UserError, failOne, type TenantContext } from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
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
} from '@nestjs/graphql';
import { SavedRepliesService, type SavedReplyRecord } from '../saved-replies.js';

@ObjectType({
  description:
    'What the shop answers customers with in a tap (MSG-06, ADR-758): changed before sending, ' +
    'as any reply.',
})
export class SavedReply {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'What staff find it by: "Delivery charges", "Bank details".' })
  title!: string;

  @Field({ description: 'The words, in English, Urdu or both.' })
  body!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class SavedReplyInput {
  @Field({
    description: 'At most 60 characters, none of the shop’s other replies’, whatever case.',
  })
  title!: string;

  @Field({ description: 'At most 4,096 characters, as a WhatsApp reply.' })
  body!: string;
}

@ObjectType()
export class SavedReplyPayload {
  @Field(() => SavedReply, { nullable: true })
  savedReply!: SavedReply | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class SavedReplyDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedSavedReplyId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

function toSavedReply(record: SavedReplyRecord): SavedReply {
  return Object.assign(new SavedReply(), { ...record, id: toPublicId('savedReply', record.id) });
}

const NOT_FOUND = () => failOne<never>(['id'], 'NOT_FOUND', 'No such saved reply');

/** The inbox's saved replies (MSG-06, ADR-758), read by all who read it, kept by those who answer. */
@Resolver(() => SavedReply)
export class SavedReplyResolver {
  constructor(private readonly replies: SavedRepliesService) {}

  @Query(() => [SavedReply], { description: "The shop's saved replies, by their titles." })
  @RequireScopes('read_conversations')
  async savedReplies(@CurrentTenant() tenant: TenantContext): Promise<SavedReply[]> {
    return (await this.replies.list(tenant)).map(toSavedReply);
  }

  @Mutation(() => SavedReplyPayload, {
    description: 'Keeps a saved reply: at most 100 a shop, each of its own title.',
  })
  @RequireScopes('write_conversations')
  async savedReplyCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input', { type: () => SavedReplyInput }) input: SavedReplyInput,
  ): Promise<SavedReplyPayload> {
    return payload(await this.replies.create(tenant, input));
  }

  @Mutation(() => SavedReplyPayload, { description: "Changes a saved reply's title and words." })
  @RequireScopes('write_conversations')
  async savedReplyUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input', { type: () => SavedReplyInput }) input: SavedReplyInput,
  ): Promise<SavedReplyPayload> {
    const uuid = tryFromPublicId(id, 'savedReply');
    return payload(uuid ? await this.replies.update(tenant, uuid, input) : NOT_FOUND());
  }

  @Mutation(() => SavedReplyDeletePayload, { description: 'Deletes a saved reply.' })
  @RequireScopes('write_conversations')
  async savedReplyDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<SavedReplyDeletePayload> {
    const uuid = tryFromPublicId(id, 'savedReply');
    const deleted = uuid ? await this.replies.delete(tenant, uuid) : false;
    return Object.assign(new SavedReplyDeletePayload(), {
      deletedSavedReplyId: deleted ? id : null,
      userErrors: deleted
        ? []
        : UserError.list([{ field: ['id'], code: 'NOT_FOUND', message: 'No such saved reply' }]),
    });
  }
}

function payload(result: Awaited<ReturnType<SavedRepliesService['create']>>): SavedReplyPayload {
  return Object.assign(new SavedReplyPayload(), {
    savedReply: result.ok ? toSavedReply(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}
