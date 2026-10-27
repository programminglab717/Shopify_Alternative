import {
  CurrentTenant,
  Loaders,
  RequestLoaders,
  RequireScopes,
  UserError,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  Args,
  Field,
  Float,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import {
  DIGITAL_LIMITS,
  DigitalProductService,
  type DigitalFileRecord,
  type DigitalFileStaged,
  type DigitalProductRecord,
} from '../digital-products.js';
import { uuidOf } from './mappers.js';
import { Product } from './product.types.js';

@ObjectType({ description: 'A file a digital product sells (ADR-813), kept privately.' })
export class DigitalFile {
  @Field(() => ID)
  id!: string;

  @Field()
  filename!: string;

  @Field({ description: 'What kind of file it is: "application/pdf".' })
  contentType!: string;

  @Field(() => Float, { description: 'Bytes.' })
  size!: number;

  @Field({ description: 'Whether it is uploaded and sold: false while its upload is staged.' })
  ready!: boolean;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType({
  description:
    'A product sold as files to download or licence keys, needing no delivery (CAT-13, ' +
    "ADR-813): once an order is paid, each unit's buyer is sent a link to its files, and a key " +
    'where it gives them.',
})
export class DigitalProduct {
  @Field(() => Int, { description: "How many times a unit's link downloads each file." })
  downloadLimit!: number;

  @Field(() => Int, { description: "How many days a unit's link lasts." })
  linkDays!: number;

  @Field({ description: 'Whether each unit is given one of its licence keys.' })
  licenceKeys!: boolean;

  @Field(() => [DigitalFile], { description: 'Its files, the oldest first.' })
  files!: DigitalFile[];

  @Field(() => Int, { description: 'Its licence keys not yet given.' })
  keysLeft!: number;

  @Field(() => Int, { description: 'Its licence keys given.' })
  keysIssued!: number;
}

@InputType()
export class DigitalProductInput {
  @Field(() => Int, {
    nullable: true,
    description: `${DIGITAL_LIMITS.downloadLimit.min} to ${DIGITAL_LIMITS.downloadLimit.max}; ${DIGITAL_LIMITS.downloadLimit.default} unless set.`,
  })
  downloadLimit?: number | null;

  @Field(() => Int, {
    nullable: true,
    description: `${DIGITAL_LIMITS.linkDays.min} to ${DIGITAL_LIMITS.linkDays.max} days; ${DIGITAL_LIMITS.linkDays.default} unless set.`,
  })
  linkDays?: number | null;

  @Field({ nullable: true, description: 'Whether each unit is given a key; false unless set.' })
  licenceKeys?: boolean;
}

@InputType()
export class DigitalFileStageInput {
  @Field({ description: 'Its name, as the buyer downloads it.' })
  filename!: string;

  @Field({ description: 'Its MIME type: "application/zip".' })
  contentType!: string;

  @Field(() => Float, { description: 'Bytes: 2 GB at most.' })
  size!: number;
}

@ObjectType({ description: 'Where to upload a staged file: PUT it there with these headers.' })
export class DigitalFileUpload {
  @Field()
  url!: string;

  @Field()
  method!: string;

  @Field(() => [DigitalUploadHeader])
  headers!: DigitalUploadHeader[];
}

@ObjectType()
export class DigitalUploadHeader {
  @Field()
  name!: string;

  @Field()
  value!: string;
}

@ObjectType({ description: 'A licence key of a digital product: never the key, but its end.' })
export class LicenceKey {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'Its last four characters.' })
  hint!: string;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When it was given.' })
  issuedAt!: Date | null;

  @Field(() => ID, { nullable: true, description: 'The order it was given for.' })
  orderId!: string | null;
}

@ObjectType()
export class DigitalProductSetPayload {
  @Field(() => DigitalProduct, { nullable: true })
  digitalProduct!: DigitalProduct | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DigitalProductRemovePayload {
  @Field({ description: 'Whether it was digital.' })
  removed!: boolean;
}

@ObjectType()
export class DigitalFileStagePayload {
  @Field(() => DigitalFile, { nullable: true })
  file!: DigitalFile | null;

  @Field(() => DigitalFileUpload, { nullable: true })
  upload!: DigitalFileUpload | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DigitalFilePayload {
  @Field(() => DigitalFile, { nullable: true })
  file!: DigitalFile | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DigitalDeletePayload {
  @Field(() => ID, { nullable: true, description: 'Null where there was nothing to delete.' })
  deletedId!: string | null;
}

@ObjectType()
export class LicenceKeysAddPayload {
  @Field(() => Int, { description: 'Keys added.' })
  added!: number;

  @Field(() => Int, { description: 'Keys given that the product had already, left out.' })
  already!: number;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const toFile = (file: DigitalFileRecord): DigitalFile =>
  Object.assign(new DigitalFile(), {
    id: toPublicId('digitalFile', file.id),
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    ready: file.status === 'ready',
    createdAt: file.createdAt,
  });

const toDigital = (record: DigitalProductRecord): DigitalProduct =>
  Object.assign(new DigitalProduct(), { ...record, files: record.files.map(toFile) });

const notFound = <T>(): MutationResult<T> =>
  failOne<T>(['productId'], 'NOT_FOUND', 'Product not found');

/** Digital products (CAT-13, ADR-813): a field of products, their files and their keys. */
@Resolver(() => Product)
export class DigitalProductResolver {
  constructor(private readonly service: DigitalProductService) {}

  @ResolveField(() => DigitalProduct, {
    nullable: true,
    description: 'How it reaches the buyer, where it is digital (ADR-813); null for goods.',
  })
  @RequireScopes('read_products')
  async digital(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() product: Product,
  ): Promise<DigitalProduct | null> {
    const loader = loaders.get<string, DigitalProductRecord>('catalog.digital', (ids) =>
      this.service.of(tenant, ids),
    );
    const record = await loader.load(uuidOf('product', product.id));
    return record ? toDigital(record) : null;
  }

  @Mutation(() => DigitalProductSetPayload, {
    description:
      'Makes a product digital, needing no delivery, or changes how it reaches the buyer. A ' +
      'gift card cannot be.',
  })
  @RequireScopes('write_products')
  async digitalProductSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('input') input: DigitalProductInput,
  ): Promise<DigitalProductSetPayload> {
    const id = tryFromPublicId(productId, 'product');
    const result = id
      ? await this.service.set(tenant, id, input)
      : notFound<DigitalProductRecord>();
    return Object.assign(new DigitalProductSetPayload(), {
      digitalProduct: result.ok ? toDigital(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => DigitalProductRemovePayload, {
    description: 'Makes a digital product goods again: its files go, and its keys not given.',
  })
  @RequireScopes('write_products')
  async digitalProductRemove(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
  ): Promise<DigitalProductRemovePayload> {
    const id = tryFromPublicId(productId, 'product');
    return Object.assign(new DigitalProductRemovePayload(), {
      removed: id ? await this.service.unset(tenant, id) : false,
    });
  }

  @Mutation(() => DigitalFileStagePayload, {
    description:
      'Stages the upload of a file a digital product sells: PUT it to the URL within the hour, ' +
      'then digitalFileCreate.',
  })
  @RequireScopes('write_products')
  async digitalFileStage(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('input') input: DigitalFileStageInput,
  ): Promise<DigitalFileStagePayload> {
    const id = tryFromPublicId(productId, 'product');
    const result = id
      ? await this.service.fileStage(tenant, id, input)
      : notFound<DigitalFileStaged>();
    return Object.assign(new DigitalFileStagePayload(), {
      file: result.ok ? toFile(result.value.file) : null,
      upload: result.ok
        ? Object.assign(new DigitalFileUpload(), {
            url: result.value.url,
            method: result.value.method,
            headers: Object.entries(result.value.headers).map(([name, value]) =>
              Object.assign(new DigitalUploadHeader(), { name, value }),
            ),
          })
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => DigitalFilePayload, {
    description: 'A staged file, once its upload is in: sold with its product from now.',
  })
  @RequireScopes('write_products')
  async digitalFileCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) fileId: string,
  ): Promise<DigitalFilePayload> {
    const id = tryFromPublicId(fileId, 'digitalFile');
    const result = id
      ? await this.service.fileCreate(tenant, id)
      : failOne<DigitalFileRecord>(['id'], 'NOT_FOUND', 'No such file');
    return Object.assign(new DigitalFilePayload(), {
      file: result.ok ? toFile(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => DigitalDeletePayload, { description: 'Removes a file a digital product sells.' })
  @RequireScopes('write_products')
  async digitalFileDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) fileId: string,
  ): Promise<DigitalDeletePayload> {
    const id = tryFromPublicId(fileId, 'digitalFile');
    return Object.assign(new DigitalDeletePayload(), {
      deletedId: id && (await this.service.fileDelete(tenant, id)) ? fileId : null,
    });
  }

  @Mutation(() => LicenceKeysAddPayload, {
    description:
      "Adds licence keys to a digital product's pool, each kept encrypted and given once: " +
      `${DIGITAL_LIMITS.keysAtOnce} at most at once, those it has already left out.`,
  })
  @RequireScopes('write_products')
  async licenceKeysAdd(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('keys', { type: () => [String] }) keys: string[],
  ): Promise<LicenceKeysAddPayload> {
    const id = tryFromPublicId(productId, 'product');
    const result = id
      ? await this.service.keysAdd(tenant, id, keys)
      : notFound<{ added: number; already: number }>();
    return Object.assign(new LicenceKeysAddPayload(), {
      added: result.ok ? result.value.added : 0,
      already: result.ok ? result.value.already : 0,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Query(() => [LicenceKey], {
    description: "A digital product's licence keys, the latest added first: never the keys.",
  })
  @RequireScopes('read_products')
  async licenceKeys(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('first', { type: () => Int, defaultValue: 50 }) first: number,
  ): Promise<LicenceKey[]> {
    const id = tryFromPublicId(productId, 'product');
    if (!id) return [];
    return (await this.service.keys(tenant, id, first)).map((key) =>
      Object.assign(new LicenceKey(), {
        id: toPublicId('licenceKey', key.id),
        hint: key.hint,
        issuedAt: key.issuedAt,
        orderId: key.orderId && toPublicId('order', key.orderId),
      }),
    );
  }

  @Mutation(() => DigitalDeletePayload, { description: 'Removes a licence key not yet given.' })
  @RequireScopes('write_products')
  async licenceKeyDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) keyId: string,
  ): Promise<DigitalDeletePayload> {
    const id = tryFromPublicId(keyId, 'licenceKey');
    return Object.assign(new DigitalDeletePayload(), {
      deletedId: id && (await this.service.keyDelete(tenant, id)) ? keyId : null,
    });
  }
}
