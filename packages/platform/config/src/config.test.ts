import { describe, expect, it } from 'vitest';
import { ConfigError, env, parseEnv, z } from './index.js';

const schema = z.object({
  NODE_ENV: env.nodeEnv(),
  PORT: env.port().default(4000),
  LOG_LEVEL: env.logLevel(),
  DATABASE_URL: env.postgresUrl(),
  REDIS_URL: env.redisUrl(),
  PUBLIC_URL: env.httpUrl().optional(),
  FEATURE_X: env.flag().default(false),
  ALLOWED_ORIGINS: env.list().default([]),
  SESSION_SECRET: env.secret(),
});

const valid = {
  DATABASE_URL: 'postgres://hatti:secret@localhost:5432/hatti',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('parseEnv', () => {
  it('applies defaults and coercion', () => {
    const config = parseEnv(schema, { ...valid, PORT: '8080', FEATURE_X: 'yes' });
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      PORT: 8080,
      LOG_LEVEL: 'info',
      FEATURE_X: true,
      ALLOWED_ORIGINS: [],
    });
  });

  it('parses lists', () => {
    const config = parseEnv(schema, {
      ...valid,
      ALLOWED_ORIGINS: 'https://a.pk, https://b.pk,,',
    });
    expect(config.ALLOWED_ORIGINS).toEqual(['https://a.pk', 'https://b.pk']);
  });

  it('treats empty strings as unset', () => {
    const config = parseEnv(schema, { ...valid, PORT: '', LOG_LEVEL: '  ' });
    expect(config.PORT).toBe(4000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(parseEnv(schema, valid))).toBe(true);
  });

  it('reports every problem without echoing values', () => {
    const secret = 'short-secret-value';
    let error: unknown;
    try {
      parseEnv(schema, {
        DATABASE_URL: 'mysql://root@localhost/db',
        REDIS_URL: 'redis://localhost:6379',
        PORT: '99999',
        SESSION_SECRET: secret,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems;
    expect(problems.map((p) => p.split(':')[0]).sort()).toEqual([
      'DATABASE_URL',
      'PORT',
      'SESSION_SECRET',
    ]);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain('mysql://');
  });

  it('rejects the wrong URL scheme', () => {
    expect(() => parseEnv(schema, { ...valid, REDIS_URL: 'http://localhost:6379' })).toThrow(
      /REDIS_URL/,
    );
    expect(() =>
      parseEnv(schema, { ...valid, DATABASE_URL: 'postgresql://localhost/hatti' }),
    ).not.toThrow();
  });
});
