import { CurrentTenant, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { File, brandUsesOf } from '@hatti/files/public';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { onlineStoreUsesOf } from '@hatti/online-store/public';
import {
  Field,
  ID,
  ObjectType,
  Parent,
  ResolveField,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';

export enum FileUseKind {
  LOGO = 'LOGO',
  SQUARE_LOGO = 'SQUARE_LOGO',
  SHARING_IMAGE = 'SHARING_IMAGE',
  ARTICLE_IMAGE = 'ARTICLE_IMAGE',
  THEME = 'THEME',
}

registerEnumType(FileUseKind, {
  name: 'FileUseKind',
  description:
    "What uses one of the shop's files (ADR-639): its logo or square logo, the sharing image of " +
    "its pages, an article's image, or a theme's settings.",
});

@ObjectType({ description: "Where one of the shop's files is used (ADR-639)." })
export class FileUse {
  @Field(() => FileUseKind)
  kind!: FileUseKind;

  @Field(() => ID, { nullable: true, description: 'The article or theme; null for the rest.' })
  id!: string | null;

  @Field(() => String, { nullable: true, description: "The article's or theme's title." })
  title!: string | null;
}

/**
 * Where the shop's files are used (ADR-639), from the files module's logos and the online
 * store's pages, articles and themes together, for a file to be deleted knowing what it leaves
 * empty.
 */
@Resolver(() => File)
export class FileUsesResolver {
  constructor(private readonly db: Database) {}

  @ResolveField(() => [FileUse], {
    description:
      'Where it is used, as the shop keeps it now: its logos, the sharing image, articles by ' +
      'title and themes by name. A page or a product names none of the shop’s files.',
  })
  async uses(@CurrentTenant() tenant: TenantContext, @Parent() file: File): Promise<FileUse[]> {
    const fileId = tryFromPublicId(file.id, 'file');
    if (!fileId) return [];
    const [brand, store] = await this.db.tenant(
      tenant.shopId,
      async (tx) =>
        [
          await brandUsesOf(tx, tenant.shopId, fileId),
          await onlineStoreUsesOf(tx, tenant.shopId, fileId, file.id),
        ] as const,
    );
    const use = (kind: FileUseKind, id: string | null = null, title: string | null = null) =>
      Object.assign(new FileUse(), { kind, id, title });
    return [
      ...brand.map((which) => use(which === 'logo' ? FileUseKind.LOGO : FileUseKind.SQUARE_LOGO)),
      ...store.map((found) =>
        found.kind === 'sharing_image'
          ? use(FileUseKind.SHARING_IMAGE)
          : found.kind === 'article_image'
            ? use(FileUseKind.ARTICLE_IMAGE, toPublicId('article', found.id), found.title)
            : use(FileUseKind.THEME, toPublicId('theme', found.id), found.title),
      ),
    ];
  }
}
