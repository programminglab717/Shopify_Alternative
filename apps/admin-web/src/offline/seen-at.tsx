import { CloudOff } from 'lucide-react';
import { formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useOnline } from './notices';

/** The phone's own time zone, for how long ago the data was fetched. */
const PHONE_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Offline, says how old what the page shows is: the data Hatti last fetched, kept for the session
 * (ADR-514). Online, the page fetches it again and says nothing.
 */
export function SeenAt({ at }: { at: number }) {
  const { t, locale } = useLocale();
  const online = useOnline();
  if (online || !at) return null;
  const when = formatRelative(new Date(at).toISOString(), PHONE_TIME_ZONE, locale);
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-secondary">
      <CloudOff aria-hidden className="size-4 shrink-0" />
      {t('offline.seenAt', { when })}
    </p>
  );
}
