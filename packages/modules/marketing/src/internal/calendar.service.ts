import { shopProfile, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import { marketingCalendar, type MarketingDate } from './calendar.js';

/** The day it is at `at` in `timeZone`: YYYY-MM-DD. */
function dayIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** A shop's marketing calendar (MKT-16, ADR-484), from its own today. */
@Injectable()
export class MarketingCalendarService {
  constructor(private readonly db: Database) {}

  /** The moments to promote for from the shop's today through `days` ahead, soonest first. */
  async calendar(tenant: TenantContext, days = 365, at = new Date()): Promise<MarketingDate[]> {
    const { timezone } = await this.db.tenant(tenant.shopId, (tx) =>
      shopProfile(tx, tenant.shopId),
    );
    return marketingCalendar(dayIn(timezone, at), days);
  }
}
