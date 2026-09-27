import {
  Body,
  Catch,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthError } from './errors.js';
import {
  IdentityService,
  type AuthenticatedSession,
  type ClientInfo,
  type SessionTokens,
} from './identity.service.js';

/** Sends {@link AuthError}s as `{ error: { code, message, fields? } }` with their status. */
@Catch(AuthError)
export class AuthErrorFilter implements ExceptionFilter {
  catch(error: AuthError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (error.details.retryAfterMs) {
      reply.header('retry-after', String(Math.ceil(error.details.retryAfterMs / 1000)));
    }
    void reply
      .status(error.status)
      .header('cache-control', 'no-store')
      .send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details.fields ? { fields: error.details.fields } : {}),
        },
      });
  }
}

const signUpBody = z.object({
  email: z.string().max(320),
  password: z.string().max(1_024),
  name: z.string().max(255),
  phone: z.string().max(32).nullish(),
});
const signInBody = z.object({ email: z.string().max(320), password: z.string().max(1_024) });
const verifyBody = z.object({ challengeToken: z.string().max(100), code: z.string().max(32) });
const refreshBody = z.object({ refreshToken: z.string().max(100) });
const codeBody = z.object({ code: z.string().max(32) });

function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const fields = Object.fromEntries(
    result.error.issues.map((issue) => [String(issue.path[0] ?? 'body'), issue.message]),
  );
  throw new AuthError('INVALID_INPUT', 400, 'The request body is not valid', { fields });
}

function clientOf(request: FastifyRequest): ClientInfo {
  const userAgent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof userAgent === 'string' ? userAgent : null };
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
}

function tokensJson(tokens: SessionTokens) {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    session: tokens.session,
  };
}

/**
 * Staff sign-in over JSON. Tokens are returned in the body for the admin web app and the merchant
 * app to keep; responses are never cached.
 */
@Controller('auth')
@UseFilters(AuthErrorFilter)
export class AuthController {
  constructor(private readonly identity: IdentityService) {}

  @Post('sign-up')
  @HttpCode(201)
  async signUp(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const result = await this.identity.signUp(parse(signUpBody, body), clientOf(request));
    return { user: result.user, ...tokensJson(result.tokens) };
  }

  @Post('sign-in')
  @HttpCode(200)
  async signIn(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const result = await this.identity.signIn(parse(signInBody, body), clientOf(request));
    return result.status === 'mfa_required'
      ? {
          status: result.status,
          challengeToken: result.challengeToken,
          challengeExpiresAt: result.challengeExpiresAt.toISOString(),
        }
      : { status: result.status, user: result.user, ...tokensJson(result.tokens) };
  }

  @Post('sign-in/verify')
  @HttpCode(200)
  async verify(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const result = await this.identity.completeSignIn(parse(verifyBody, body), clientOf(request));
    return { status: 'signed_in', user: result.user, ...tokensJson(result.tokens) };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const { refreshToken } = parse(refreshBody, body);
    return tokensJson(await this.identity.refresh(refreshToken, clientOf(request)));
  }

  @Post('sign-out')
  @HttpCode(204)
  async signOut(@Req() request: FastifyRequest): Promise<void> {
    await this.identity.signOut(await this.session(request), clientOf(request));
  }

  @Get('me')
  async me(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    noStore(reply);
    return this.identity.me(await this.session(request));
  }

  @Get('sessions')
  async sessions(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    noStore(reply);
    const sessions = await this.identity.listSessions(await this.session(request));
    return { sessions };
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@Param('id') id: string, @Req() request: FastifyRequest): Promise<void> {
    await this.identity.revokeSession(await this.session(request), id, clientOf(request));
  }

  @Post('two-step/totp/setup')
  @HttpCode(200)
  async setUpTotp(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    noStore(reply);
    return this.identity.setUpTotp(await this.session(request));
  }

  @Post('two-step/totp/confirm')
  @HttpCode(200)
  async confirmTotp(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const { code } = parse(codeBody, body);
    return this.identity.confirmTotp(await this.session(request), code, clientOf(request));
  }

  private session(request: FastifyRequest): Promise<AuthenticatedSession> {
    return this.identity.authenticate(bearerToken(request));
  }
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}
