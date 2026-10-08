// @vitest-environment node
import { readFileSync } from 'node:fs';
import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import * as operations from './operations';

// The Admin API's schema as the core generates it (apps/core/schema.graphql): every document the
// admin sends must be valid against it, so a field renamed or removed fails here, not in a shop.
const schema = buildSchema(
  readFileSync(new URL('../../../core/schema.graphql', import.meta.url), 'utf8'),
);

describe('The Admin API documents the admin sends', () => {
  const documents = Object.entries(operations as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );

  it('has documents to check', () => {
    expect(documents.length).toBeGreaterThan(0);
  });

  it.each(documents)('%s is valid against the Admin API schema', (_name, document) => {
    expect(validate(schema, parse(document)).map((error) => error.message)).toEqual([]);
  });
});
