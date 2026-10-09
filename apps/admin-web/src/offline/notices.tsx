import { CloudOff, RefreshCw } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
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
 * What every page of the admin says above itself (ADR-295): that the phone is offline, so the
 * shop's work waits for a connection; and that a new version of Hatti is ready, with a button to
 * reload onto it.
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
  if (online && !update) return null;
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
