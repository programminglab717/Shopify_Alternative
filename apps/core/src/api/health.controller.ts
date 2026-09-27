import { Database } from '@hatti/db';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { REDIS } from './constants.js';

type CheckResult = 'ok' | 'failed';

async function check(probe: () => Promise<unknown>, timeoutMs = 2_000): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return 'ok';
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}

/** Liveness and readiness probes for Kubernetes and load balancers. */
@Controller()
export class HealthController {
  constructor(
    private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  /** The process is up. Never checks dependencies, so a database outage does not restart pods. */
  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Dependencies answer, so the process can take traffic. */
  @Get('readyz')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const redis = this.redis;
    const checks = {
      database: await check(() => this.db.ping()),
      ...(redis ? { redis: await check(() => redis.ping()) } : {}),
    };
    const ok = Object.values(checks).every((result) => result === 'ok');
    reply.code(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks };
  }
}
