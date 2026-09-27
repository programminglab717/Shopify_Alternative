import { v7, validate, version } from 'uuid';

/**
 * Creates a new primary key. UUIDv7 values are time-ordered, which keeps B-tree
 * indexes compact and lets IDs double as a creation-order sort key.
 */
export function newId(): string {
  return v7();
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && validate(value);
}

export function uuidVersion(value: string): number {
  return version(value);
}
