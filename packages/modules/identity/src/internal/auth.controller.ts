import {
  Body,
  Catch,
  Controller,
  Delete,
  Get,
  HttpCode,
  Optional,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { PublicSite } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { shopAgreementDocuments } from './agreements.js';
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
import { StaffService, type AccessRequestRecord } from './staff.service.js';
import {
  PartnersService,
  type PartnerEarnings,
  type PartnerProfile,
  type PartnerStore,
} from './partners.service.js';
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
const accessRequestBody = z.object({
  shop: z.string().min(1).max(100),
  role: z.string().max(40),
  accessDays: z.number().int(),
  message: z.string().max(1000).nullish(),
});
const passkeyBody = z.object({
  response: registrationResponseSchema,
  name: z.string().max(200).nullish(),
});
const reauthenticateBody = z
  .object({
    password: z.string().max(1_024).nullish(),
    code: z.string().max(32).nullish(),
    passkey: authenticationResponseSchema.nullish(),
    googleIdToken: z.string().max(4_096).nullish(),
    phoneCode: z.string().max(32).nullish(),
  })
  .refine(
    (body) =>
      [body.password, body.code, body.passkey, body.googleIdToken, body.phoneCode].filter(Boolean)
        .length === 1,
    {
      path: ['password'],
      message: "Give one of a password, a code, a passkey, Google's sign-in or a code sent to you",
    },
  );
const reauthenticationCodeBody = phoneCodeBody.omit({ phone: true });
const refreshBody = z.object({ refreshToken: z.string().max(100) });
const shopBody = z.object({
  name: z.string().max(1_024),
  handle: z.string().max(100).nullish(),
  referralCode: z.string().max(32).nullish(),
  // Each of Hatti's documents agreed to, by the version shown: { "terms": "2026-10-22", … }.
  agreed: z.record(z.string().max(40), z.string().max(20)).nullish(),
});
const agreementBody = shopBody.pick({ agreed: true });
const closeBody = z.object({ name: z.string().max(1_024) });
const codeBody = z.object({ code: z.string().max(32) });
const partnerBody = z.object({
  businessName: z.string().max(1_024),
  website: z.string().max(1_024).nullish(),
  payoutTitle: z.string().max(1_024).nullish(),
  payoutIban: z.string().max(64).nullish(),
});

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
/** A request for access as its asker sees it (ADR-488): which shop, as what, and its status. */
function accessRequestJson(request: AccessRequestRecord) {
  return {
    id: toPublicId('accessRequest', request.id),
    shop: { name: request.shop.name },
    role: request.role,
    accessDays: request.accessDays,
    message: request.message,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    expiresAt: request.expiresAt.toISOString(),
  };
}

/** A partner as they see themselves (ADR-504). */
function partnerJson(partner: PartnerProfile) {
  return {
    businessName: partner.businessName,
    website: partner.website,
    referralCode: partner.referralCode,
    payout: partner.payout,
    joinedAt: partner.joinedAt.toISOString(),
  };
}

/** What a partner earned, its sums in paisa as strings (ADR-505). */
function earningsJson(earnings: PartnerEarnings) {
  return {
    earned: earnings.earned.toString(),
    paidOut: earnings.paidOut.toString(),
    owed: earnings.owed.toString(),
    entries: earnings.entries.map((entry) => ({
      ...entry,
      invoiceAmount: entry.invoiceAmount.toString(),
      amount: entry.amount.toString(),
      earnedAt: entry.earnedAt.toISOString(),
      paidOutAt: entry.paidOutAt?.toISOString() ?? null,
    })),
  };
}

/** A store on a partner's dashboard (ADR-504). */
function partnerStoreJson(store: PartnerStore) {
  return {
    id: toPublicId('shop', store.shopId),
    name: store.name,
    handle: store.handle,
    status: store.status,
    kind: store.kind,
    role: store.role,
    accessEndsAt: store.accessEndsAt?.toISOString() ?? null,
    since: store.since.toISOString(),
    transferredAt: store.transferredAt?.toISOString() ?? null,
  };
}

@Controller('auth')
@UseFilters(AuthErrorFilter)
export class AuthController {
  constructor(
    private readonly identity: IdentityService,
    private readonly staff: StaffService,
    private readonly support: SupportAccessService,
    private readonly partners: PartnersService,
    @Optional() private readonly site?: PublicSite,
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

  /**
   * Takes the number off the signed-in user's account (ADR-202), unless it is how they sign in
   * alone: a number proved signs in to nothing from then on, and is told. The user.
   */
  @Delete('phone')
  @HttpCode(200)
  async removePhone(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    return this.identity.removePhone(await this.session(request), clientOf(request));
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
   * What opening a shop asks its owner to agree to (ADR-737): Hatti's terms of service, acceptable
   * use policy and data processing agreement, each with its version and where to read it.
   */
  @Get('agreement')
  agreement(@Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'public, max-age=300');
    return {
      documents: shopAgreementDocuments().map((document) => ({
        ...document,
        url: this.site?.url(`/legal/${document.handle}`) ?? `/legal/${document.handle}`,
      })),
    };
  }

  /**
   * Opens a shop of the signed-in user's own (ONB-01, ADR-145): `{ name, handle?, referralCode?,
   * agreed }`, the code a partner's link brought them by (ADR-505), and the versions of Hatti's
   * terms they agreed to, as `GET /auth/agreement` gives them (ADR-737); the shop, its handle and
   * the user's role in it. Its owner signs in with a second factor to use it.
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

  /**
   * Agrees to Hatti's terms for a shop the signed-in user owns, as they are now (ADR-739): `{
   * agreed }`, the versions `GET /auth/agreement` gave, when `/auth/me` says its agreement is due.
   */
  @Post('shops/:id/agreement')
  @HttpCode(200)
  async agreeToTerms(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    return this.identity.agreeToTerms(
      await this.session(request),
      id,
      parse(agreementBody, body).agreed,
      clientOf(request),
    );
  }

  /**
   * Closes a shop the signed-in user owns (ADR-740), `{ name }` typed as it is, once they have
   * confirmed who they are lately: its storefront, checkout and Admin API stop, and its data stays
   * 90 days, during which they may reopen it. When it closed and when its data goes.
   */
  @Post('shops/:id/close')
  @HttpCode(200)
  async closeShop(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const shop = await this.identity.closeShop(
      await this.session(request),
      id,
      parse(closeBody, body),
      clientOf(request),
    );
    return { shop };
  }

  /** Reopens a shop its owner closed, while its data is kept (ADR-740): the shop, as on opening. */
  @Post('shops/:id/reopen')
  @HttpCode(200)
  async reopenShop(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const shop = await this.identity.reopenShop(await this.session(request), id, clientOf(request));
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
   * methods their account takes, what `navigator.credentials.get()` takes for a passkey, the
   * client ID and nonce for Google's sign-in, and the number, masked, a code would go to
   * (ADR-201).
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

  /**
   * Sends a code to the signed-in user's proved number, to confirm who they are with where their
   * account takes one (ADR-201): `{ channel?, language? }`; as `/auth/phone/code` answers.
   */
  @Post('reauthenticate/code')
  @HttpCode(200)
  async reauthenticationCode(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const sent = await this.identity.sendReauthenticationCode(
      await this.session(request),
      parse(reauthenticationCodeBody, body),
      clientOf(request),
    );
    return {
      phone: sent.phone,
      channel: sent.channel,
      expiresAt: sent.expiresAt.toISOString(),
      resendAfter: sent.resendAfter.toISOString(),
    };
  }

  /**
   * Confirms who is at this session, for the sensitive actions of the next 15 minutes: one of
   * `{ password }`, `{ code }`, `{ passkey }`, `{ googleIdToken }` or `{ phoneCode }`.
   */
  @Post('reauthenticate')
  @HttpCode(200)
  async reauthenticate(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const { password, code, passkey, googleIdToken, phoneCode } = parse(reauthenticateBody, body);
    const result = await this.identity.reauthenticate(
      await this.session(request),
      { password, code, passkey: passkey && asAuthentication(passkey), googleIdToken, phoneCode },
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
   * Asks a shop, by its handle, for access in a role for 1 to 90 days, for the signed-in account
   * (ADR-488): an agency's or a freelancer's. Its owner, or a manager, approves or declines it in
   * the Admin API.
   */
  @Post('access-requests')
  @HttpCode(201)
  async requestAccess(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const made = await this.staff.requestAccess(
      await this.session(request),
      parse(accessRequestBody, body),
      clientOf(request),
    );
    return { request: accessRequestJson(made) };
  }

  /** The signed-in account's own requests for access of the last 30 days, and what became of each. */
  @Get('access-requests')
  async accessRequests(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const requests = await this.staff.accessRequestsBy(await this.session(request));
    return { requests: requests.map(accessRequestJson) };
  }

  /**
   * The signed-in account's partner profile, stores and earnings (PRT-01, PRT-02, ADR-504,
   * ADR-505): `{ partner, stores, earnings }`, the partner and earnings null and the stores none
   * until they join.
   */
  @Get('partner')
  async partner(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    noStore(reply);
    const session = await this.session(request);
    const partner = await this.partners.profile(session);
    const [stores, earnings] = partner
      ? await Promise.all([this.partners.stores(session), this.partners.earnings(session)])
      : [[], null];
    return {
      partner: partner && partnerJson(partner),
      stores: stores.map(partnerStoreJson),
      earnings: earnings && earningsJson(earnings),
    };
  }

  /**
   * Joins Hatti's partner programme, or changes the partner's details: `{ businessName, website?,
   * payoutTitle?, payoutIban? }` (ADR-504, ADR-505), the bank account their share is paid into
   * given whole or not at all. The partner, with the referral code they were given.
   */
  @Post('partner')
  @HttpCode(200)
  async joinPartners(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const partner = await this.partners.join(await this.session(request), parse(partnerBody, body));
    return { partner: partnerJson(partner) };
  }

  /**
   * Opens a development store for a partner to build (ADR-504): `{ name, handle?, agreed }`, the
   * partner agreeing to Hatti's terms as its owner meanwhile (ADR-737). Closed to
   * shoppers until the partner hands it to its client, as an owner hands over any shop.
   */
  @Post('partner/stores')
  @HttpCode(201)
  async openDevelopmentStore(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    noStore(reply);
    const shop = await this.partners.openDevelopmentStore(
      await this.session(request),
      parse(shopBody, body),
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
