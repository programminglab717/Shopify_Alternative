import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
} from '@nestjs/graphql';

@ObjectType({
  description:
    'A file the shop uploaded, such as an image for its pages or the logo on its checkout ' +
    "(ADR-079): kept in the platform's storage, and shown only through short-lived URLs.",
})
export class File {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'As the shop named it: "Lawn collection.jpg".' })
  filename!: string;

  @Field({ description: 'image/jpeg, image/png, image/webp, image/gif or application/pdf.' })
  mimeType!: string;

  @Field(() => Int, { description: 'Bytes.' })
  fileSize!: number;

  @Field({ description: "What it shows, for those who can't see it; empty for nothing." })
  alt!: string;

  @Field({
    description:
      'Where it is shown, for an hour from when it was asked for: ask again for a new one.',
  })
  url!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class FileEdge {
  @Field()
  cursor!: string;

  @Field(() => File)
  node!: File;
}

@ObjectType()
export class FileConnection {
  @Field(() => [FileEdge])
  edges!: FileEdge[];

  @Field(() => [File])
  nodes!: File[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class FilesArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@InputType({ description: "A file to upload, as Shopify's stagedUploadsCreate takes it." })
export class StagedUploadInput {
  @Field({ description: 'Its name, up to 255 characters: "Lawn collection.jpg".' })
  filename!: string;

  @Field({
    description: 'image/jpeg, image/png, image/webp, image/gif or application/pdf.',
  })
  mimeType!: string;

  @Field({ description: 'Bytes, 1 to 20 MiB, as a string: "123456".' })
  fileSize!: string;
}

@ObjectType({ description: 'A header to send with the upload, as given.' })
export class StagedUploadParameter {
  @Field()
  name!: string;

  @Field()
  value!: string;
}

@ObjectType({
  description:
    'Where to upload a file: PUT its bytes to `url`, with `parameters` as headers, within the ' +
    'hour, then give `resourceUrl` to fileCreate.',
})
export class StagedMediaUploadTarget {
  @Field()
  url!: string;

  @Field({ description: 'PUT.' })
  httpMethod!: string;

  @Field(() => [StagedUploadParameter])
  parameters!: StagedUploadParameter[];

  @Field({ description: 'What fileCreate takes as originalSource, once the bytes are in.' })
  resourceUrl!: string;
}

@ObjectType()
export class StagedUploadsCreatePayload {
  @Field(() => [StagedMediaUploadTarget], { nullable: true })
  stagedTargets!: StagedMediaUploadTarget[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@InputType()
export class FileCreateInput {
  @Field({ description: "A staged upload's resourceUrl." })
  originalSource!: string;

  @Field(() => String, { nullable: true, description: 'Up to 512 characters.' })
  alt?: string | null;
}

@ObjectType()
export class FileCreatePayload {
  @Field(() => [File], { nullable: true })
  files!: File[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class FileDeletePayload {
  @Field(() => [ID], { nullable: true })
  deletedFileIds!: string[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    "The shop's brand (ADR-081): its logo, which its checkout's page shows in place of its " +
    "name, as Shopify's shop.brand.logo.",
})
export class ShopBrand {
  @Field(() => File, {
    nullable: true,
    description: "One of the shop's files, an image; null for none, when pages show its name.",
  })
  logo!: File | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Null until first set.' })
  updatedAt!: Date | null;
}

@InputType()
export class ShopBrandInput {
  @Field(() => ID, {
    nullable: true,
    description:
      "One of the shop's files, an image: JPEG, PNG, WebP or GIF; null to have none. Left as " +
      'it is if absent.',
  })
  logo?: string | null;
}

@ObjectType()
export class ShopBrandUpdatePayload {
  @Field(() => ShopBrand, { nullable: true })
  brand!: ShopBrand | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
