import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { LocalStorage, S3Storage, type ObjectStorage } from '@hatti/storage';
import type { ApiConfig } from './config.js';

/** Where the API serves local storage's files: {PUBLIC_URL}/storage/{key}. */
export const LOCAL_STORAGE_PATH = '/storage';

/**
 * The storage `config` names (ADR-079): a bucket through the S3 API, R2's in production; or a
 * directory, which the API serves at `publicUrl`/storage, for development.
 */
export function createStorage(config: ApiConfig, publicUrl: string): ObjectStorage {
  if (config.STORAGE_DRIVER === 's3') {
    return new S3Storage({
      endpoint: config.S3_ENDPOINT!,
      bucket: config.S3_BUCKET!,
      region: config.S3_REGION,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID!,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
      },
    });
  }
  return new LocalStorage({
    directory: resolve(config.STORAGE_DIRECTORY),
    baseUrl: `${publicUrl}${LOCAL_STORAGE_PATH}`,
    // A new one at each start, unless set: URLs signed before a restart stop working.
    secret: config.STORAGE_SECRET ?? randomBytes(32),
  });
}
