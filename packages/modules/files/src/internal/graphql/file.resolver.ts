import {
  CurrentTenant,
  PageInfo,
  RequireScopes,
  UserError,
  badUserInput,
  decodeCursor,
  encodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { FileService } from '../file.service.js';
import type { FileRecord } from '../records.js';
import {
  File,
  FileConnection,
  FileCreateInput,
  FileCreatePayload,
  FileDeletePayload,
  FileEdge,
  FilesArgs,
  StagedMediaUploadTarget,
  StagedUploadInput,
  StagedUploadParameter,
  StagedUploadsCreatePayload,
} from './file.types.js';

/** Files a shop uploads (ADR-079), with Shopify's file scopes and staged uploads. */
@Resolver(() => File)
export class FileResolver {
  constructor(private readonly service: FileService) {}

  @Query(() => FileConnection, { description: "The shop's files, newest first." })
  @RequireScopes('read_files')
  async files(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: FilesArgs,
  ): Promise<FileConnection> {
    const after = args.after ? uuidOf(decodeCursor(args.after, ['id']).id) : null;
    const first = pageSize(args.first);
    const { items, hasNextPage } = await this.service.list(tenant, { first, after });
    const nodes = items.map((record) => this.#toFile(record));
    const edges = nodes.map((node) =>
      Object.assign(new FileEdge(), { cursor: encodeCursor({ id: node.id }), node }),
    );
    return Object.assign(new FileConnection(), {
      edges,
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @Query(() => File, { nullable: true })
  @RequireScopes('read_files')
  async file(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<File | null> {
    const record = await this.service.get(tenant, uuidOf(id));
    return record ? this.#toFile(record) : null;
  }

  @Mutation(() => StagedUploadsCreatePayload, {
    description:
      'Where to upload files, up to 10 at a time, for an hour: PUT each one there, then make ' +
      'files of them with fileCreate.',
  })
  @RequireScopes('write_files')
  async stagedUploadsCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input', { type: () => [StagedUploadInput] }) input: StagedUploadInput[],
  ): Promise<StagedUploadsCreatePayload> {
    const result = await this.service.stage(tenant, input);
    return Object.assign(new StagedUploadsCreatePayload(), {
      stagedTargets: result.ok
        ? result.value.map((upload) =>
            Object.assign(new StagedMediaUploadTarget(), {
              url: upload.url,
              httpMethod: upload.method,
              parameters: Object.entries(upload.headers).map(([name, value]) =>
                Object.assign(new StagedUploadParameter(), { name, value }),
              ),
              resourceUrl: upload.resourceUrl,
            }),
          )
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => FileCreatePayload, {
    description:
      'Makes files of uploads, by their resourceUrls, once each is in, of the size and type it ' +
      'was staged as. An upload that is not what it said it was is removed.',
  })
  @RequireScopes('write_files')
  async fileCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('files', { type: () => [FileCreateInput] }) files: FileCreateInput[],
  ): Promise<FileCreatePayload> {
    const result = await this.service.create(tenant, files);
    return Object.assign(new FileCreatePayload(), {
      files: result.ok ? result.value.map((record) => this.#toFile(record)) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => FileDeletePayload, {
    description: 'Deletes files, up to 10 at a time, and what storage keeps of them.',
  })
  @RequireScopes('write_files')
  async fileDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('fileIds', { type: () => [ID] }) fileIds: string[],
  ): Promise<FileDeletePayload> {
    const result = await this.service.delete(tenant, fileIds.map(uuidOf));
    return Object.assign(new FileDeletePayload(), {
      deletedFileIds: result.ok ? result.value.map((id) => toPublicId('file', id)) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  #toFile(record: FileRecord): File {
    return toFile(record, this.service);
  }
}

/** A file as the Admin API shows it, with a URL that shows it for an hour. */
export function toFile(record: FileRecord, service: FileService): File {
  return Object.assign(new File(), {
    id: toPublicId('file', record.id),
    filename: record.filename,
    mimeType: record.contentType,
    fileSize: record.size,
    alt: record.alt,
    url: service.urlOf(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

/** The UUID behind a file's public ID, or a BAD_USER_INPUT error. */
export function uuidOf(id: string): string {
  const uuid = tryFromPublicId(id, 'file');
  if (!uuid) throw badUserInput(`Invalid file id: ${id.slice(0, 64)}`);
  return uuid;
}
