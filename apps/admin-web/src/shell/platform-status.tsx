import { ExternalLink, TriangleAlert, Wrench } from 'lucide-react';
import { PlatformStatusQuery } from '../api/operations';
import type { PlatformIncidentValue, PlatformStatusData } from '../api/types';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminQuery, useShopTimezone } from './shop-context';

/** How often the banner asks Hatti again: as often as the status page's edge keeps it. */
export const STATUS_ASK_AGAIN_MS = 60_000;

/**
 * Above every page of a shop's admin, while anything is wrong at Hatti, or maintenance is
 * planned within a day (BIL-06, ADR-499): what it touches, what Hatti said last, in the staff's
 * language where Hatti wrote it in Urdu too, and a link to Hatti's status page. Nothing while all
 * is well, or while Hatti can't be asked.
 */
export function PlatformStatusBanner() {
  const { t } = useLocale();
  const query = useAdminQuery<PlatformStatusData>(
    ['platformStatus'],
    PlatformStatusQuery,
    undefined,
    { refetchInterval: () => STATUS_ASK_AGAIN_MS },
  );
  const status = query.data?.platformStatus;
  if (!status || status.incidents.length === 0) return null;
  return (
    <section
      aria-label={t('platformStatus.label')}
      className="flex flex-col gap-2 px-4 pt-4 md:px-6"
    >
      {status.incidents.map((incident) => (
        <Incident key={incident.id} incident={incident} pageUrl={status.statusPageUrl} />
      ))}
    </section>
  );
}

function Incident({ incident, pageUrl }: { incident: PlatformIncidentValue; pageUrl: string }) {
  const { t, locale } = useLocale();
  const timeZone = useShopTimezone();
  const urdu = locale === 'ur';
  const update = incident.latestUpdate;
  const maintenance = incident.kind === 'MAINTENANCE';
  const Icon = maintenance ? Wrench : TriangleAlert;
  const at = (iso: string) => formatDateTime(iso, timeZone, locale);
  const tone =
    incident.impact === 'OUTAGE' && !(maintenance && incident.status === 'SCHEDULED')
      ? 'border-danger'
      : 'border-warning';
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-control border-s-4 bg-surface p-3 ${tone}`}
    >
      <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-secondary" />
      <div className="flex min-w-0 flex-col gap-1 text-text">
        <p className="font-medium" dir="auto">
          {(urdu && incident.titleUr) || incident.title}
        </p>
        <p className="text-sm text-secondary">
          {t(`platformStatus.status.${incident.status}`)} ·{' '}
          {t(`platformStatus.impact.${incident.impact}`)} ·{' '}
          {t('platformStatus.touches', {
            components: incident.components
              .map((component) => t(`platformStatus.component.${component}`))
              .join(', '),
          })}
        </p>
        {maintenance && (
          <p className="text-sm text-secondary">
            {incident.endsAt
              ? t('platformStatus.between', {
                  from: at(incident.startsAt),
                  to: at(incident.endsAt),
                })
              : t('platformStatus.from', { from: at(incident.startsAt) })}
          </p>
        )}
        <p className="text-sm" dir="auto">
          {(urdu && update.bodyUr) || update.body}
        </p>
        <a
          href={pageUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
        >
          {t('platformStatus.page')}
          <ExternalLink aria-hidden className="size-4" />
        </a>
      </div>
    </div>
  );
}
