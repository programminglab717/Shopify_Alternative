import 'reflect-metadata';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { ModulesContainer } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Nest's injection of every provider", () => {
  let testDb: TestDatabase;
  let api: TestApi;

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    api = await startTestApi(testDb);
  });

  afterAll(async () => {
    await api?.close();
    await testDb?.drop();
  });

  it('names what each constructor takes: a type TypeScript cannot keep, such as a union with null, is named by @Inject', () => {
    // A parameter typed `Service | null` is kept as Object, which Nest finds nothing for: an
    // @Optional() one is then left out silently, as replies from a shop's own WhatsApp number
    // once were (ADR-813).
    const unnamed: string[] = [];
    for (const module of api.app.get(ModulesContainer).values()) {
      for (const wrapper of [...module.providers.values(), ...module.controllers.values()]) {
        const type = wrapper.metatype;
        if (typeof type !== 'function' || wrapper.inject) continue;
        const params = (Reflect.getMetadata('design:paramtypes', type) ?? []) as unknown[];
        const named = new Set(
          ((Reflect.getMetadata('self:paramtypes', type) ?? []) as { index: number }[]).map(
            (each) => each.index,
          ),
        );
        params.forEach((param, index) => {
          if ((param === Object || param === undefined) && !named.has(index)) {
            unnamed.push(`${type.name} #${index}`);
          }
        });
      }
    }
    expect([...new Set(unnamed)].sort()).toEqual([]);
  });
});
