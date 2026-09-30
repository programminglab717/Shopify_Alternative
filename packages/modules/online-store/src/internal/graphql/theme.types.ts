import { PageInfo, UserError } from '@hatti/api';
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

export enum ThemeRole {
  MAIN = 'MAIN',
  UNPUBLISHED = 'UNPUBLISHED',
}

registerEnumType(ThemeRole, {
  name: 'ThemeRole',
  description: 'Whether the storefront shows a theme.',
  valuesMap: {
    MAIN: { description: 'The theme the storefront shows. A shop has one.' },
    UNPUBLISHED: { description: 'Being prepared, or shown before; publish it to show it.' },
  },
});

@ObjectType({
  description:
    "One of the shop's own files in a theme, over the platform theme's file of that name: a " +
    'JSON template, a section group or the theme settings.',
})
export class OnlineStoreThemeFile {
  @Field({ description: 'Such as templates/index.json or config/settings_data.json.' })
  filename!: string;

  @Field({ description: 'The JSON, as saved.' })
  body!: string;

  @Field(() => Int, { description: 'In bytes.' })
  size!: number;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType({
  description:
    "A shop's theme: a platform theme, such as Hatti Base, with the shop's own templates, section " +
    'groups and settings over it.',
})
export class OnlineStoreTheme {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => ThemeRole)
  role!: ThemeRole;

  @Field({ description: 'The platform theme it is built on, such as hatti-base.' })
  base!: string;

  @Field(() => Int, { description: 'Goes up with every change to the theme.' })
  version!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class OnlineStoreThemeEdge {
  @Field()
  cursor!: string;

  @Field(() => OnlineStoreTheme)
  node!: OnlineStoreTheme;
}

@ObjectType()
export class OnlineStoreThemeConnection {
  @Field(() => [OnlineStoreThemeEdge])
  edges!: OnlineStoreThemeEdge[];

  @Field(() => [OnlineStoreTheme])
  nodes!: OnlineStoreTheme[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class ThemesArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => [ThemeRole], { nullable: true, description: 'Only themes with these roles.' })
  roles?: ThemeRole[] | null;
}

@InputType()
export class OnlineStoreThemeFilesUpsertFileInput {
  @Field({
    description:
      'templates/<name>.json (such as templates/index.json or templates/product.unstitched.json), ' +
      'sections/<group>.json, or config/settings_data.json.',
  })
  filename!: string;

  @Field({ description: 'JSON, at most 256 KB.' })
  body!: string;
}

@ObjectType()
export class ThemeCreatePayload {
  @Field(() => OnlineStoreTheme, { nullable: true })
  theme!: OnlineStoreTheme | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ThemePublishPayload {
  @Field(() => OnlineStoreTheme, { nullable: true })
  theme!: OnlineStoreTheme | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ThemeDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedThemeId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ThemeFilesUpsertPayload {
  @Field(() => OnlineStoreTheme, { nullable: true })
  theme!: OnlineStoreTheme | null;

  @Field(() => [OnlineStoreThemeFile], { description: 'The files saved.' })
  upsertedThemeFiles!: OnlineStoreThemeFile[];

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ThemeFilesDeletePayload {
  @Field(() => OnlineStoreTheme, { nullable: true })
  theme!: OnlineStoreTheme | null;

  @Field(() => [String], {
    description: 'The files deleted; those the theme did not have are left out.',
  })
  deletedThemeFiles!: string[];

  @Field(() => [UserError])
  userErrors!: UserError[];
}
