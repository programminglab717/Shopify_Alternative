import { PageInfo, UserError } from '@hatti/api';
import { ArgsType, Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum MenuItemType {
  FRONTPAGE = 'FRONTPAGE',
  CATALOG = 'CATALOG',
  COLLECTION = 'COLLECTION',
  PRODUCT = 'PRODUCT',
  HTTP = 'HTTP',
  COLLECTIONS = 'COLLECTIONS',
  PAGE = 'PAGE',
  BLOG = 'BLOG',
  ARTICLE = 'ARTICLE',
  SEARCH = 'SEARCH',
  SHOP_POLICY = 'SHOP_POLICY',
  METAOBJECT = 'METAOBJECT',
  CUSTOMER_ACCOUNT_PAGE = 'CUSTOMER_ACCOUNT_PAGE',
}

const NOT_YET = { description: 'Not available yet: menus refuse it.' };

registerEnumType(MenuItemType, {
  name: 'MenuItemType',
  description: "What a menu item links to. Shopify's kinds, of which the first five work now.",
  valuesMap: {
    FRONTPAGE: { description: 'The home page.' },
    CATALOG: { description: 'All products, at /collections/all.' },
    COLLECTION: { description: 'A collection, which `resourceId` names.' },
    PRODUCT: { description: 'A product, which `resourceId` names.' },
    HTTP: {
      description:
        '`url`: a path on the storefront, such as /collections/eid?sort_by=price-ascending, or ' +
        'a web, mail or phone address.',
    },
    COLLECTIONS: NOT_YET,
    PAGE: NOT_YET,
    BLOG: NOT_YET,
    ARTICLE: NOT_YET,
    SEARCH: NOT_YET,
    SHOP_POLICY: NOT_YET,
    METAOBJECT: NOT_YET,
    CUSTOMER_ACCOUNT_PAGE: NOT_YET,
  },
});

@ObjectType({ description: "A link in a shop's menu, with the links under it." })
export class MenuItem {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field(() => MenuItemType)
  type!: MenuItemType;

  @Field(() => ID, { nullable: true, description: 'The collection or product it links to.' })
  resourceId!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Where it leads on the storefront, as the collection or product it links to is now, or ' +
      'the address it links to. Null if that collection or product is gone.',
  })
  url!: string | null;

  @Field(() => [String], { description: 'Empty: menu items do not take tags yet.' })
  tags!: string[];

  @Field(() => [MenuItem], { description: 'Three levels at most.' })
  items!: MenuItem[];
}

@ObjectType({
  description:
    "A shop's menu, which its storefront's theme shows by handle, as linklists['main-menu'].",
})
export class Menu {
  @Field(() => ID)
  id!: string;

  @Field()
  handle!: string;

  @Field()
  title!: string;

  @Field({
    description:
      'The main menu and the footer menu, which every shop has: they keep their handles and are ' +
      'not deleted.',
  })
  isDefault!: boolean;

  @Field(() => [MenuItem])
  items!: MenuItem[];
}

@ObjectType()
export class MenuEdge {
  @Field()
  cursor!: string;

  @Field(() => Menu)
  node!: Menu;
}

@ObjectType()
export class MenuConnection {
  @Field(() => [MenuEdge])
  edges!: MenuEdge[];

  @Field(() => [Menu])
  nodes!: Menu[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class MenusArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;
}

@InputType({ description: 'A link in a new menu, with the links under it.' })
export class MenuItemCreateInput {
  @Field()
  title!: string;

  @Field(() => MenuItemType)
  type!: MenuItemType;

  @Field(() => ID, { nullable: true, description: 'The collection or product it links to.' })
  resourceId?: string | null;

  @Field(() => String, { nullable: true, description: "An HTTP link's address." })
  url?: string | null;

  @Field(() => [String], { nullable: true, description: 'Not available yet: leave it empty.' })
  tags?: string[] | null;

  @Field(() => [MenuItemCreateInput], { nullable: true })
  items?: MenuItemCreateInput[] | null;
}

@InputType({
  description:
    "A link in a menu being changed, with the links under it. The menu's items not given go.",
})
export class MenuItemUpdateInput {
  @Field(() => ID, { nullable: true, description: 'The item it was, to keep its ID; new if not.' })
  id?: string | null;

  @Field()
  title!: string;

  @Field(() => MenuItemType)
  type!: MenuItemType;

  @Field(() => ID, { nullable: true, description: 'The collection or product it links to.' })
  resourceId?: string | null;

  @Field(() => String, { nullable: true, description: "An HTTP link's address." })
  url?: string | null;

  @Field(() => [String], { nullable: true, description: 'Not available yet: leave it empty.' })
  tags?: string[] | null;

  @Field(() => [MenuItemUpdateInput], { nullable: true })
  items?: MenuItemUpdateInput[] | null;
}

@ObjectType()
export class MenuCreatePayload {
  @Field(() => Menu, { nullable: true })
  menu!: Menu | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class MenuUpdatePayload {
  @Field(() => Menu, { nullable: true })
  menu!: Menu | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class MenuDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedMenuId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
