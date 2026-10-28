import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthErrorFilter } from './auth.controller.js';
import { ConsoleAuthService, type ConsoleAgent, type ConsoleSignInProblem } from './console.js';
import { AuthError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** One of Hatti's people, signed in to the console (ADR-876). */
    consoleAgent?: ConsoleAgent;
  }
}

const startBody = z.object({ email: z.string().max(320).nullish() });
const redeemBody = z.object({ code: z.string().min(1).max(128) });

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
}

const signedOut = () =>
  new AuthError('CONSOLE_SIGNED_OUT', 401, 'Your console session has ended. Sign in again');

/** The console's own: a session of one of Hatti's agents, in the `Authorization` header. */
@Injectable()
export class ConsoleGuard implements CanActivate {
  constructor(private readonly console: ConsoleAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    reply.header('cache-control', 'no-store');
    const token = bearerToken(request);
    const agent = token ? await this.console.agentOf(token) : null;
    if (!agent) throw signedOut();
    request.consoleAgent = agent;
    return true;
  }
}

/** The agent the guard let through. */
export function consoleAgentOf(request: FastifyRequest): ConsoleAgent {
  if (!request.consoleAgent) throw signedOut();
  return request.consoleAgent;
}

export function consoleAgentJson(agent: ConsoleAgent) {
  return { email: agent.email, name: agent.name, expiresAt: agent.expiresAt.toISOString() };
}

const PROBLEMS: Record<ConsoleSignInProblem, string> = {
  unavailable: "Hatti's sign-in isn't set up for the console",
  unreachable: "Hatti's sign-in can't be reached now. Try again in a minute",
  expired: 'This sign-in has expired. Start it again',
  refused: 'The sign-in was refused or cancelled',
  invalid: "The sign-in's answer couldn't be trusted. Start it again",
  not_agent: "That account isn't one of Hatti's support agents",
  no_key: 'Sign in with your security key',
};

/**
 * Signing in to Hatti's console (ADR-876), at `/console/api/auth`, which the console's address
 * passes on to the core: the provider's address to go to, its answer, the session it gives, and
 * signing out.
 */
@Controller('console/api/auth')
@UseFilters(AuthErrorFilter)
export class ConsoleAuthController {
  constructor(private readonly console: ConsoleAuthService) {}

  /** Starts a sign-in through Hatti's provider: `{ url, state }`, the state for the tab to keep. */
  @Post('start')
  @HttpCode(200)
  async start(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const parsed = startBody.safeParse(body ?? {});
    const started = await this.console.start(parsed.success ? parsed.data.email : null);
    if ('problem' in started) {
      throw new AuthError(
        started.problem === 'unavailable' ? 'CONSOLE_NOT_SET_UP' : 'CONSOLE_UNREACHABLE',
        503,
        PROBLEMS[started.problem],
      );
    }
    return started;
  }

  /** Where the provider sends the browser back: on to the console with a code, or why not. */
  @Get('callback')
  async callback(
    @Query() query: Record<string, string | undefined>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const finished = await this.console.finish({
      code: query.code ?? null,
      state: query.state ?? null,
      error: query.error ?? null,
    });
    const page = new URL('/signed-in', this.console.consoleUrl ?? 'http://localhost:5174');
    if ('handoff' in finished) {
      page.searchParams.set('code', finished.handoff);
      page.searchParams.set('state', query.state ?? '');
    } else {
      page.searchParams.set('error', finished.problem);
    }
    reply.header('cache-control', 'no-store');
    await reply.redirect(page.toString(), 303);
  }

  /** Trades the provider's answer, `{ code }`, for the console's session: once, within minutes. */
  @Post('redeem')
  @HttpCode(200)
  async redeem(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    const parsed = redeemBody.safeParse(body ?? {});
    const userAgent = request.headers['user-agent'];
    const redeemed = parsed.success
      ? await this.console.redeem(parsed.data.code, {
          ip: request.ip,
          userAgent: typeof userAgent === 'string' ? userAgent : null,
        })
      : null;
    if (!redeemed) throw new AuthError('CONSOLE_EXPIRED', 400, PROBLEMS.expired);
    return { token: redeemed.token, agent: consoleAgentJson(redeemed.agent) };
  }

  @Get('me')
  @UseGuards(ConsoleGuard)
  me(@Req() request: FastifyRequest) {
    return { agent: consoleAgentJson(consoleAgentOf(request)) };
  }

  @Post('sign-out')
  @HttpCode(204)
  async signOut(@Req() request: FastifyRequest): Promise<void> {
    const token = bearerToken(request);
    if (token) await this.console.signOut(token);
  }
}
