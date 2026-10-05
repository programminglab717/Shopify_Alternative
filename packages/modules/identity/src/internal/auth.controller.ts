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
import { toPublicId } from '@hatti/ids';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthError } from './errors.js';
import {
  IdentityService,
  type AuthenticatedSession,
  type ClientInfo,
  type SessionTokens,
  type SignInResult,
} from './identity.service.js';
import {
  authenticationResponseSchema,
  registrationResponseSchema,
  type PasskeyAuthenticationResponse,
} from './passkeys.js';
import { DEVICE_HEADER } from './sign-in-alerts.js';
import { StaffService } from './staff.service.js';
import { SupportAccessService } from './support-access.service.js';

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

const language = z.enum(['en', 'ur']).nullish();
const signUpBody = z.object({
  email: z.string().max(320),
  password: z.string().max(1_024),
  name: z.string().max(255),
  phone: z.string().max(32).nullish(),
  language,
});
const signInBody = z.object({ email: z.string().max(320), password: z.string().max(1_024) });
const phoneCodeBody = z.object({
  phone: z.string().max(32),
  channel: z.enum(['whatsapp', 'sms']).nullish(),
  language: z.enum(['en', 'ur']).nullish(),
});
const phoneSignInBody = z.object({ phone: z.string().max(32), code: z.string().max(32) });
const addPhoneBody = phoneSignInBody.extend({ language });
const phoneSignUpBody = z.object({
  signUpToken: z.string().max(100),
  name: z.string().max(255),
  email: z.string().max(320).nullish(),
  language,
});
const emailVerificationBody = z.object({ language });
const emailLinkBody = z.object({ token: z.string().max(100) });
const emailChangeBody = z.object({ email: z.string().max(320), language });
const forgotPasswordBody = z.object({ email: z.string().max(320), language });
const resetPasswordBody = z.object({
  token: z.string().max(100),
  password: z.string().max(1_024),
});
const googleBody = z.object({ idToken: z.string().max(4_096), language });
const languageBody = z.object({ language: z.enum(['en', 'ur']) });
const verifyBody = z
  .object({
    challengeToken: z.string().max(100),
    code: z.string().max(32).nullish(),
    passkey: authenticationResponseSchema.nullish(),
  })
  .refine((body) => Boolean(body.code) !== Boolean(body.passkey), {
    path: ['code'],
    message: 'Give a code or a passkey: one of them',
  });
const passkeySignInBody = z.object({ response: authenticationResponseSchema });
const invitationBody = z.object({ token: z.string().max(100) });
const passkeyBody = z.object({
  response: registrationResponseSchema,
  name: z.string().max(200).nullish(),
});
const reauthenticateBody = z
  .object({
    password: z.string().max(1_024).nullish(),
    code: z.string().max(32).nullish(),
    passkey: authenticationResponseSchema.nullish(),
  })
  .refine((body) => [body.password, body.code, body.passkey].filter(Boolean).length === 1, {
    path: ['password'],
    message: 'Give one of a password, a code or a passkey',
  });
const refreshBody = z.object({ refreshToken: z.string().max(100) });
const shopBody = z.object({ name: z.string().max(1_024), handle: z.string().max(100).nullish() });
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
  // The random ID the client keeps for its device, which tells sign-ins from new devices (ADR-179).
  const deviceId = request.headers[DEVICE_HEADER];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
    deviceId: typeof deviceId === 'string' ? deviceId : null,
  };
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

/** A first factor's outcome: signed in, or the second factor still to give. */
function signInJson(result: SignInResult) {
  return result.status === 'mfa_required'
    ? {
        status: result.status,
        challengeToken: result.challengeToken,
        challengeExpiresAt: result.challengeExpiresAt.toISOString(),
        methods: result.methods,
        passkeyOptions: result.passkeyOptions,
      }
    : { status: result.status, user: result.user, ...tokensJson(result.tokens) };
}

/**
 * Staff sign-in over JSON. Tokens are returned in the body for the admin web app and the merchant
 * app to keep; responses are never cached.
 */
@Controller('auth')
@UseFilters(AuthErrorFilter)
export class AuthController {
  constructor(
    private readonly identity: IdentityService,
    private readonly staff: StaffService,
    private readonly support: SupportAccessService,
  ) {}

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
    return signInJson(await this.identity.signIn(parse(signInBody, body), clientOf(request)));
  }

  /**
   * Sends a code to a Pakistani mobile number, to sign in or open an account with it (ONB-01,
   * ADR-159): `{ phone, channel?, language? }`; the number, masked, the channel it went by, when it
   * expires, and when another may be asked for.
   */
  @Post('phone/code')
  @HttpCode(200)
  async phoneCode(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const sent = await this.identity.sendPhoneCode(parse(phoneCodeBody, body), clientOf(request));
    return {
      phone: sent.phone,
      channel: sent.channel,
      expiresAt: sent.expiresAt.toISOString(),
      resendAfter: sent.resendAfter.toISOString(),
    };
  }

  /**
   * Signs in with the code sent to a number: `{ phone, code }`. Signed in, or a second factor to
   * give, as after a password; or, for a number no account has, `sign_up_required` with the token
   * that opens one at `/auth/phone/sign-up`.
   */
  @Post('phone/sign-in')
  @HttpCode(200)
  async phoneSignIn(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const result = await this.identity.phoneSignIn(parse(phoneSignInBody, body), clientOf(request));
    if (result.status === 'sign_up_required') {
      return {
        status: result.status,
        signUpToken: result.signUpToken,
        signUpTokenExpiresAt: result.signUpTokenExpiresAt.toISOString(),
        phone: result.phone,
      };
    }
    return signInJson(result);
  }

  /**
   * Proves a number for the signed-in user's account with the code sent to it, `{ phone, code,
   * language? }` (ADR-166): it signs the account in from then on, in place of any before it, and a
   * number proved before is told, in `language` (ADR-173). The user.
   */
  @Post('phone')
  @HttpCode(200)
  async addPhone(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    return this.identity.addPhone(
      await this.session(request),
      parse(addPhoneBody, body),
      clientOf(request),
    );
  }

  /** Opens an account with a number just proved: `{ signUpToken, name, email? }`; signed in. */
  @Post('phone/sign-up')
  @HttpCode(201)
  async phoneSignUp(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const result = await this.identity.phoneSignUp(parse(phoneSignUpBody, body), clientOf(request));
    return { user: result.user, ...tokensJson(result.tokens) };
  }

  /**
   * Starts signing in with Google, or connecting a Google account (ONB-01, ADR-164): the client ID
   * the admin's "Sign in with Google" takes, and the nonce to start it with, which Google's ID
   * token brings back once, before `expiresAt`.
   */
  @Post('google/options')
  @HttpCode(200)
  async googleOptions(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const options = await this.identity.googleOptions(clientOf(request));
    return {
      clientId: options.clientId,
      nonce: options.nonce,
      expiresAt: options.expiresAt.toISOString(),
    };
  }

  /**
   * Signs in with the ID token Google's sign-in gave: `{ idToken }`. Signed in, or a second factor
   * to give, as after a password; a Google account connected to no account opens one, `signedUp`.
   */
  @Post('google/sign-in')
  @HttpCode(200)
  async googleSignIn(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const result = await this.identity.signInWithGoogle(parse(googleBody, body), clientOf(request));
    return { ...signInJson(result), signedUp: result.signedUp };
  }

  /**
   * Connects a Google account to the signed-in user's, `{ idToken }`, to sign them in from then
   * on; from a session that proved who is at it lately (ADR-103).
   */
  @Post('google')
  @HttpCode(201)
  async connectGoogle(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const google = await this.identity.connectGoogle(
      await this.session(request),
      parse(googleBody, body),
      clientOf(request),
    );
    return { google: { email: google.email, connectedAt: google.connectedAt.toISOString() } };
  }

  /** Disconnects the user's Google account, unless it is the only way they sign in. */
  @Delete('google')
  @HttpCode(204)
  async disconnectGoogle(@Req() request: FastifyRequest): Promise<void> {
    await this.identity.disconnectGoogle(await this.session(request), clientOf(request));
  }

  /**
   * Sends the signed-in user a link proving their account's email (ADR-165), `{ language? }`: the
   * email, when the link expires, and when another may be sent.
   */
  @Post('email/verification')
  @HttpCode(200)
  async sendEmailVerification(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const sent = await this.identity.sendEmailVerification(
      await this.session(request),
      parse(emailVerificationBody, body),
      clientOf(request),
    );
    return {
      email: sent.email,
      expiresAt: sent.expiresAt.toISOString(),
      resendAfter: sent.resendAfter.toISOString(),
    };
  }

  /** Proves an account's email with the token its link carried, `{ token }`; the user. */
  @Post('email/verify')
  @HttpCode(200)
  async verifyEmail(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    return this.identity.verifyEmail(parse(emailLinkBody, body), clientOf(request));
  }

  /**
   * Sends a link proving a new email for the signed-in user's account, `{ email, language? }`
   * (ADR-172), from a session proved lately: the email, when the link expires, and when another may
   * be sent. Nothing changes until it is opened.
   */
  @Post('email/change')
  @HttpCode(200)
  async requestEmailChange(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const sent = await this.identity.requestEmailChange(
      await this.session(request),
      parse(emailChangeBody, body),
      clientOf(request),
    );
    return {
      email: sent.email,
      expiresAt: sent.expiresAt.toISOString(),
      resendAfter: sent.resendAfter.toISOString(),
    };
  }

  /** Changes an account's email with the token its change link carried, `{ token }`; the user. */
  @Post('email/change/confirm')
  @HttpCode(200)
  async confirmEmailChange(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    return this.identity.confirmEmailChange(parse(emailLinkBody, body), clientOf(request));
  }

  /**
   * Sends a link resetting the password of the account with an email, `{ email, language? }`:
   * accepted the same whether or not an account has it.
   */
  @Post('password/forgot')
  @HttpCode(202)
  async forgotPassword(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    await this.identity.requestPasswordReset(parse(forgotPasswordBody, body), clientOf(request));
    return {};
  }

  /** Sets a new password with the token a reset link carried, `{ token, password }`. */
  @Post('password/reset')
  @HttpCode(204)
  async resetPassword(@Body() body: unknown, @Req() request: FastifyRequest): Promise<void> {
    await this.identity.resetPassword(parse(resetPasswordBody, body), clientOf(request));
  }

  /** What `navigator.credentials.get()` takes to sign in with a passkey alone (ADR-100). */
  @Post('sign-in/passkey/options')
  @HttpCode(200)
  async passkeySignInOptions(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    return { options: await this.identity.passkeySignInOptions(clientOf(request)) };
  }

  @Post('sign-in/passkey')
  @HttpCode(200)
  async signInWithPasskey(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const { response } = parse(passkeySignInBody, body);
    const result = await this.identity.signInWithPasskey(
      { response: asAuthentication(response) },
      clientOf(request),
    );
    return { status: 'signed_in', user: result.user, ...tokensJson(result.tokens) };
  }

  @Post('sign-in/verify')
  @HttpCode(200)
  async verify(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const { challengeToken, code, passkey } = parse(verifyBody, body);
    const result = await this.identity.completeSignIn(
      { challengeToken, code, passkey: passkey && asAuthentication(passkey) },
      clientOf(request),
    );
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

  /**
   * Sets the language Hatti's emails and messages to the signed-in user are in, `{ language }`,
   * en or ur (ADR-194): sign-in alerts, links, codes and what the worker sends them. The user.
   */
  @Post('language')
  @HttpCode(200)
  async setLanguage(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    return this.identity.setLanguage(await this.session(request), parse(languageBody, body));
  }

  /**
   * Opens a shop of the signed-in user's own (ONB-01, ADR-145): `{ name, handle? }`; the shop, its
   * handle and the user's role in it. Its owner signs in with a second factor to use it.
   */
  @Post('shops')
  @HttpCode(201)
  async openShop(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const shop = await this.identity.openShop(
      await this.session(request),
      parse(shopBody, body),
      clientOf(request),
    );
    return { shop };
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

  /**
   * How the signed-in user can confirm who they are before a sensitive action (ADR-103): the
   * methods their account takes, and what `navigator.credentials.get()` takes for a passkey.
   */
  @Post('reauthenticate/options')
  @HttpCode(200)
  async reauthenticationOptions(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    return this.identity.reauthenticationOptions(await this.session(request));
  }

  /** Confirms who is at this session, for the sensitive actions of the next 15 minutes. */
  @Post('reauthenticate')
  @HttpCode(200)
  async reauthenticate(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const { password, code, passkey } = parse(reauthenticateBody, body);
    const result = await this.identity.reauthenticate(
      await this.session(request),
      { password, code, passkey: passkey && asAuthentication(passkey) },
      clientOf(request),
    );
    return {
      authenticatedAt: result.authenticatedAt.toISOString(),
      sensitiveActionsUntil: result.sensitiveActionsUntil.toISOString(),
    };
  }

  @Get('passkeys')
  async passkeys(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    noStore(reply);
    return { passkeys: await this.identity.listPasskeys(await this.session(request)) };
  }

  /** What `navigator.credentials.create()` takes to add a passkey. */
  @Post('passkeys/options')
  @HttpCode(200)
  async passkeyOptions(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    return {
      options: await this.identity.passkeyRegistrationOptions(await this.session(request)),
    };
  }

  @Post('passkeys')
  @HttpCode(201)
  async addPasskey(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const { response, name } = parse(passkeyBody, body);
    return this.identity.registerPasskey(
      await this.session(request),
      { response: response as unknown as RegistrationResponseJSON, name },
      clientOf(request),
    );
  }

  @Delete('passkeys/:id')
  @HttpCode(204)
  async removePasskey(@Param('id') id: string, @Req() request: FastifyRequest): Promise<void> {
    await this.identity.removePasskey(await this.session(request), id, clientOf(request));
  }

  /**
   * What an invitation to work in a shop says (ADR-101), for the page its link opens, before
   * anyone signs in: the token is the secret, in the body rather than the address.
   */
  @Post('invitations/preview')
  @HttpCode(200)
  async previewInvitation(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    noStore(reply);
    const preview = await this.staff.preview(parse(invitationBody, body).token);
    if (!preview) {
      throw new AuthError(
        'INVALID_INVITATION',
        404,
        'This invitation was accepted, taken back or has expired. Ask for a new one',
      );
    }
    return { invitation: { ...preview, expiresAt: preview.expiresAt.toISOString() } };
  }

  /** Accepts an invitation for the signed-in user, who works in the shop from now on. */
  @Post('invitations/accept')
  @HttpCode(200)
  async acceptInvitation(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const shop = await this.staff.accept(
      await this.session(request),
      parse(invitationBody, body).token,
      clientOf(request),
    );
    return { shop };
  }

  /**
   * For Hatti's support agents (ADR-156): the shops whose owners let support look now, the
   * soonest to close first, each to name in the Admin API's shop header. Agents sign in with a
   * second factor to see them.
   */
  @Get('support/shops')
  async supportShops(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const session = await this.session(request);
    if (!(await this.support.isAgent(session.userId))) {
      throw new AuthError(
        'NOT_SUPPORT',
        403,
        "Only Hatti's support agents see the shops open to them",
      );
    }
    if (!session.mfaVerified) {
      throw new AuthError(
        'MFA_REQUIRED',
        403,
        "Hatti's support signs in with a second factor to look at shops",
      );
    }
    const shops = await this.support.shopsOpenTo(session.userId);
    return {
      shops: shops.map((shop) => ({
        id: toPublicId('shop', shop.shopId),
        name: shop.name,
        handle: shop.handle,
        note: shop.note,
        expiresAt: shop.expiresAt.toISOString(),
      })),
    };
  }

  private session(request: FastifyRequest): Promise<AuthenticatedSession> {
    return this.identity.authenticate(bearerToken(request));
  }
}

/** A passkey's response, its shape checked here; what it says, the library checks. */
function asAuthentication(response: PasskeyAuthenticationResponse): AuthenticationResponseJSON {
  return response as unknown as AuthenticationResponseJSON;
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}
