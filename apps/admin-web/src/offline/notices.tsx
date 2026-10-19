import { CloudOff, Hourglass, RefreshCw } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { busyUntil, watchBusy } from '../api/client';
import { useLocale } from '../i18n/locale';
import { takeOver, UPDATE_READY, updateWaiting } from './register';

const subscribe = (changed: () => void) => {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
};

/** Whether the browser is online, as it says and as that changes. */
export const useOnline = () =>
  useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );

/**
 * The seconds until a request waiting for the shop's query budget is sent again, counting down,
 * or null when none waits (ADR-577).
 */
export function useBusySeconds(): number | null {
  const until = useSyncExternalStore(watchBusy, busyUntil, () => null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (until === null) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [until]);
  return until === null ? null : Math.max(1, Math.ceil((until - now) / 1000));
}

/**
 * What every page of the admin says above itself (ADR-295): that the phone is offline, so the
 * shop's work waits for a connection; quietly, that Hatti is busy for the shop and tries again in
 * a moment (ADR-577); and that a new version of Hatti is ready, with a button to reload onto it.
 */
export function AppNotices() {
  const { t } = useLocale();
  const online = useOnline();
  const [update, setUpdate] = useState<ServiceWorker | null>(updateWaiting);
  useEffect(() => {
    const ready = () => setUpdate(updateWaiting());
    window.addEventListener(UPDATE_READY, ready);
    return () => window.removeEventListener(UPDATE_READY, ready);
  }, []);
  const busy = useBusySeconds();
  if (online && !update && busy === null) return null;
  return (
    <div className="sticky top-0 z-50 flex flex-col text-sm">
      {!online && (
        <p
          role="status"
          className="flex items-center justify-center gap-2 bg-text px-4 py-2 text-center text-surface"
        >
          <CloudOff aria-hidden className="size-4 shrink-0" />
          {t('offline.notice')}
        </p>
      )}
      {busy !== null && (
        <p
          role="status"
          className="flex items-center justify-center gap-2 border-b border-line bg-surface px-4 py-2 text-center text-secondary"
        >
          <Hourglass aria-hidden className="size-4 shrink-0" />
          {t('busy.retrying', { count: busy })}
        </p>
      )}
      {update && (
        <div
          role="status"
          className="flex items-center justify-center gap-3 bg-primary px-4 py-2 text-on-primary"
        >
          {t('update.ready')}
          <button
            type="button"
            onClick={() => takeOver(update)}
            className="inline-flex min-h-10 items-center gap-1 rounded-control border border-current px-3 font-medium"
          >
            <RefreshCw aria-hidden className="size-4" />
            {t('update.reload')}
          </button>
        </div>
      )}
    </div>
  );
}
