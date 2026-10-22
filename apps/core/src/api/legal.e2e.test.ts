import 'reflect-metadata';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Hatti's legal documents on the core's own address (ADR-736)", () => {
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

  it('serves the list, each document and their versions, and says so of one it has not', async () => {
    const list = await api.app.inject({ method: 'GET', url: '/legal' });
    expect(list.statusCode).toBe(200);
    expect(list.headers['content-type']).toContain('text/html');
    expect(list.headers['cache-control']).toBe('public, max-age=300');
    expect(list.headers['content-security-policy']).toContain("default-src 'none'");
    expect(list.body).toContain('href="/legal/data-processing"');

    const terms = await api.app.inject({ method: 'GET', url: '/legal/terms' });
    expect(terms.statusCode).toBe(200);
    expect(terms.body).toContain('Terms of service');
    expect(terms.body).toContain('سروس کی شرائط');

    const missing = await api.app.inject({ method: 'GET', url: '/legal/cookies' });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('There&#39;s no such document');

    const json = await api.app.inject({ method: 'GET', url: '/legal.json' });
    expect(json.statusCode).toBe(200);
    expect(json.headers['access-control-allow-origin']).toBe('*');
    const body = json.json<{ reviewed: boolean; documents: { handle: string; path: string }[] }>();
    expect(body.reviewed).toBe(false);
    expect(body.documents.map((document) => document.handle)).toEqual([
      'terms',
      'privacy',
      'acceptable-use',
      'data-processing',
      'sub-processors',
    ]);
  });
});
