import {
  CurrentTenant,
  Loaders,
  Money,
  RequestLoaders,
  RequireScopes,
  UserError,
  failOne,
  type TenantContext,
} from '@hatti/api';
import { tryFromPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import { Args, ID, Mutation, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import {
  PersonalisationService,
  type PersonalisationField as FieldValue,
  type PersonalisationKindValue,
} from '../personalisation.js';
import { uuidOf } from './mappers.js';
import {
  PersonalisationField,
  PersonalisationFieldInput,
  PersonalisationFieldKind,
  ProductPersonalisationSetPayload,
} from './personalisation.types.js';
import { Product } from './product.types.js';

const toField = (value: FieldValue, tenant: TenantContext): PersonalisationField =>
  Object.assign(new PersonalisationField(), {
    ...value,
    kind: value.kind === 'choice' ? PersonalisationFieldKind.CHOICE : PersonalisationFieldKind.TEXT,
    price: value.price > 0 ? Money.from(money(BigInt(value.price), tenant.currency)) : null,
  });

/**
 * What a product's page asks the shopper for (CAT-15, ADR-689): a field of products, and setting
 * it.
 */
@Resolver(() => Product)
export class PersonalisationResolver {
  constructor(private readonly service: PersonalisationService) {}

  @ResolveField(() => [PersonalisationField], {
    description:
      'What its page asks the shopper for, in order, at most 5: each answer a property of the ' +
      'cart line (ADR-689).',
  })
  @RequireScopes('read_products')
  async personalisationFields(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
  ): Promise<PersonalisationField[]> {
    const loader = loaders.get<string, FieldValue[]>('catalog.personalisation', (ids) =>
      this.service.of(tenant, ids),
    );
    return ((await loader.load(uuidOf('product', product.id))) ?? []).map((field) =>
      toField(field, tenant),
    );
  }

  @Mutation(() => ProductPersonalisationSetPayload, {
    description:
      "Sets what a product's page asks the shopper for, in order, in place of what it asked; " +
      'none, and it asks for nothing.',
  })
  @RequireScopes('write_products')
  async productPersonalisationSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('fields', { type: () => [PersonalisationFieldInput] })
    fields: PersonalisationFieldInput[],
  ): Promise<ProductPersonalisationSetPayload> {
    const id = tryFromPublicId(productId, 'product');
    const result = id
      ? await this.service.set(
          tenant,
          id,
          fields.map((field) => ({
            ...field,
            kind: field.kind.toLowerCase() as PersonalisationKindValue,
          })),
        )
      : failOne<FieldValue[]>(['productId'], 'NOT_FOUND', 'Product not found');
    return Object.assign(new ProductPersonalisationSetPayload(), {
      personalisationFields: result.ok ? result.value.map((field) => toField(field, tenant)) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
