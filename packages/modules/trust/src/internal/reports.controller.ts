import { reportsPath, type ReportErrorResponse, type ReportResponse } from '@hatti/storefront-api';
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
import { ReportsService } from './reports.service.js';

/**
 * Reports of a store, as storefronts send them on (ADR-460): `POST
 * /storefront/shops/{shop}/reports`. 422 says what was wrong with one. The host application
 * checks the storefront key before any of this runs.
 */
@Controller(reportsPath(':shopId').slice(1))
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async report(@Param('shopId') shopId: string, @Body() body: unknown): Promise<ReportResponse> {
    if (!isUuid(shopId)) throw new NotFoundException();
    const fields =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const text = (name: string) => (typeof fields[name] === 'string' ? fields[name] : null);
    const result = await this.reports.report(shopId, {
      reason: text('reason'),
      details: text('details'),
      phone: text('phone'),
      orderName: text('orderName'),
      pageUrl: text('pageUrl'),
      client: text('client'),
      language: text('language') === 'ur' ? 'ur' : 'en',
    });
    if (!result.ok) {
      throw new UnprocessableEntityException({
        errors: result.errors.map(({ field, message }) => ({ field: field.join('.'), message })),
      } satisfies ReportErrorResponse);
    }
    return { id: toPublicId('storeReport', result.value.id) };
  }
}
