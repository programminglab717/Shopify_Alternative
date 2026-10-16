import {
  rightsComplaintsPath,
  type ReportErrorResponse,
  type ReportResponse,
} from '@hatti/storefront-api';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { isUuid, toPublicId } from '@hatti/ids';
import { RightsComplaintsService, type RightsListing } from './rights.service.js';

/**
 * Rights owners' complaints of a store's listings, as storefronts send them on (ADR-474): `POST
 * /storefront/shops/{shop}/rights-complaints`. 422 says what was wrong with one. The host
 * application checks the storefront key before any of this runs.
 */
@Controller(rightsComplaintsPath(':shopId').slice(1))
export class RightsComplaintsController {
  constructor(private readonly rights: RightsComplaintsService) {}

  @Post()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async complain(@Param('shopId') shopId: string, @Body() body: unknown): Promise<ReportResponse> {
    if (!isUuid(shopId)) throw new NotFoundException();
    const fields =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const text = (name: string) => (typeof fields[name] === 'string' ? fields[name] : null);
    const listings: RightsListing[] = (Array.isArray(fields.listings) ? fields.listings : [])
      .slice(0, 50)
      .map((listing: unknown) => {
        const each =
          typeof listing === 'object' && listing !== null
            ? (listing as Record<string, unknown>)
            : {};
        const field = (name: string) => (typeof each[name] === 'string' ? each[name] : '');
        return { id: field('id'), title: field('title'), url: field('url') };
      });
    const result = await this.rights.complain(shopId, {
      kind: text('kind'),
      rightsOwner: text('rightsOwner'),
      registration: text('registration'),
      complainant: text('complainant'),
      actingAs: text('actingAs'),
      email: text('email'),
      phone: text('phone'),
      listings,
      details: text('details'),
      signature: text('signature'),
      sworn: fields.sworn === true,
      client: text('client'),
      language: text('language') === 'ur' ? 'ur' : 'en',
    });
    if (!result.ok) {
      throw new UnprocessableEntityException({
        errors: result.errors.map(({ field, message }) => ({ field: field.join('.'), message })),
      } satisfies ReportErrorResponse);
    }
    return { id: toPublicId('rightsComplaint', result.value.id) };
  }
}
