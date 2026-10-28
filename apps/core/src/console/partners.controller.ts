import {
  AuthErrorFilter,
  ConsoleAuthService,
  ConsoleGuard,
  ExpertsService,
  PartnerAppsService,
  PartnerThemesService,
  PartnersService,
  consoleAgentOf,
  type ExpertRecord,
  type PartnerAppRecord,
  type PartnerOwed,
  type ThemeListingRecord,
} from '@hatti/identity/public';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { formatMoney, money } from '@hatti/money';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { consoleWords, notFound } from './trust.controller.js';

const rupees = (paisa: bigint) => formatMoney(money(paisa, 'PKR'));

function appJson(app: PartnerAppRecord & { partner: string }) {
  return {
    clientId: app.clientId,
    name: app.name,
    partner: app.partner,
    appUrl: app.appUrl,
    redirectUrls: app.redirectUrls,
    scopes: app.scopes,
    listed: app.listed,
    createdAt: app.createdAt.toISOString(),
  };
}

function themeJson(theme: ThemeListingRecord) {
  return {
    id: toPublicId('themeListing', theme.id),
    name: theme.name,
    description: theme.description,
    designer: theme.designer,
    base: theme.base,
    price: theme.price === 0n ? null : rupees(theme.price),
    listed: theme.listed,
    preview: {
      shopId: toPublicId('shop', theme.sourceShopId),
      themeId: toPublicId('theme', theme.sourceThemeId),
    },
    updatedAt: theme.updatedAt.toISOString(),
  };
}

function expertJson(expert: ExpertRecord) {
  return {
    id: toPublicId('expert', expert.partnerId),
    businessName: expert.businessName,
    website: expert.website,
    headline: expert.headline,
    about: expert.about,
    services: expert.services,
    cities: expert.cities,
    languages: expert.languages,
    startingPrice: expert.startingPrice > 0n ? rupees(expert.startingPrice) : null,
    certified: expert.certified,
    listed: expert.listed,
    updatedAt: expert.updatedAt.toISOString(),
  };
}

function owedJson(partner: PartnerOwed) {
  return {
    id: toPublicId('user', partner.userId),
    businessName: partner.businessName,
    email: partner.email,
    payout: partner.payout,
    owed: rupees(partner.owed),
    entries: partner.entries,
  };
}

/**
 * Hatti's reviews of partners' work in the console (ADR-880), as their commands have them:
 * public apps (ADR-851), themes for the theme store (ADR-853) and expert profiles (ADR-855) listed
 * for every shop once checked against the review list in docs/developers/README.md, or taken back;
 * and partners paid their share (ADR-505) once the bank transfer is made. Each logged first.
 */
@Controller('console/api')
@UseGuards(ConsoleGuard)
@UseFilters(AuthErrorFilter)
export class ConsolePartnersController {
  constructor(
    private readonly console: ConsoleAuthService,
    private readonly apps: PartnerAppsService,
    private readonly themes: PartnerThemesService,
    private readonly experts: ExpertsService,
    private readonly partners: PartnersService,
  ) {}

  /** Partners' public apps, those waiting first. */
  @Get('partner-apps')
  async appsList() {
    return { apps: (await this.apps.all()).map(appJson) };
  }

  /** Lists an app for every shop to install, or takes it back to its partner's stores. */
  @Post('partner-apps/:clientId/:review')
  @HttpCode(200)
  async reviewApp(
    @Param('clientId') clientId: string,
    @Param('review') review: string,
    @Req() request: FastifyRequest,
  ) {
    const listed = this.#listed(review);
    await this.console.record(
      consoleAgentOf(request),
      `partner_app.${review}`,
      clientId.slice(0, 100),
    );
    const app = await this.apps.review(clientId, listed);
    if (!app) throw notFound('app with that client ID');
    return { app: { clientId: app.clientId, name: app.name, listed: app.listed } };
  }

  /** Designers' themes, those waiting first. */
  @Get('partner-themes')
  async themesList() {
    return { themes: (await this.themes.all()).map(themeJson) };
  }

  /** Puts a theme in the theme store, or takes it out; shops that bought it keep it. */
  @Post('partner-themes/:id/:review')
  @HttpCode(200)
  async reviewTheme(
    @Param('id') id: string,
    @Param('review') review: string,
    @Req() request: FastifyRequest,
  ) {
    const listed = this.#listed(review);
    const listing = tryFromPublicId(id, 'themeListing');
    if (!listing) throw notFound('theme');
    await this.console.record(consoleAgentOf(request), `partner_theme.${review}`, id);
    const theme = await this.themes.review(listing, listed);
    if (!theme) throw notFound('theme');
    return { theme: themeJson(theme) };
  }

  /** Partners' expert profiles, those waiting first. */
  @Get('experts')
  async expertsList() {
    return { experts: (await this.experts.all()).map(expertJson) };
  }

  /** Shows an expert to shops, or stops. */
  @Post('experts/:id/:review')
  @HttpCode(200)
  async reviewExpert(
    @Param('id') id: string,
    @Param('review') review: string,
    @Req() request: FastifyRequest,
  ) {
    const listed = this.#listed(review);
    const partner = tryFromPublicId(id, 'expert');
    if (!partner) throw notFound('expert');
    await this.console.record(consoleAgentOf(request), `expert.${review}`, id);
    const expert = await this.experts.review(partner, listed);
    if (!expert) throw notFound('expert');
    return { expert: expertJson(expert) };
  }

  /** Partners owed their share, and into which account. */
  @Get('partner-payouts')
  async owed() {
    return { partners: (await this.partners.owed()).map(owedJson) };
  }

  /**
   * Marks everything a partner was owed paid, `{ reference }`, the bank transfer's, once it is
   * made: what was marked.
   */
  @Post('partner-payouts/:id/pay')
  @HttpCode(200)
  async pay(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const reference = consoleWords(body, 'reference', 100, {
      message: "Give the bank transfer's reference",
    });
    const partner = tryFromPublicId(id, 'user');
    if (!partner) throw notFound('partner');
    await this.console.record(consoleAgentOf(request), 'partner_payout.pay', id, { reference });
    const paid = await this.partners.payOut(partner, reference);
    return { paid: rupees(paid), nothingOwed: paid === 0n };
  }

  #listed(review: string): boolean {
    if (review !== 'list' && review !== 'unlist') throw notFound('review');
    return review === 'list';
  }
}
