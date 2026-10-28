import { useQueryClient } from '@tanstack/react-query';
import { CloudUpload, TriangleAlert, X } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { forget, queued, sendQueued, watchQueued } from './outbox';
import { useOnline } from './notices';

/** How often what waits is tried again while the phone says it is online. */
const AGAIN_MS = 30_000;

/**
 * The changes saved on the phone while it was offline (APP-05, ADR-840): sent, the oldest first,
 * as soon as it is back online and every half a minute after, in this tab alone where the
 * browser can say so; how many wait, above every page; and each the core refused, with why,
 * until staff dismiss it.
 */
export function OutboxSender() {
  const { t } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const online = useOnline();
  const list = useSyncExternalStore(watchQueued, queued, () => []);
  const waiting = list.filter((each) => !each.refused).length;

  useEffect(() => {
    if (!online || waiting === 0) return;
    const run = async () => {
      const sent = await sendQueued(
        (change) =>
          store.graphql(change.shopId, change.document, change.variables, {
            idempotencyKey: change.id,
          }),
        (error) => errorText(error, t),
      );
      if (sent > 0) await queryClient.invalidateQueries({ queryKey: ['admin'] });
    };
    const once = () =>
      navigator.locks
        ? navigator.locks.request('hatti-outbox', { ifAvailable: true }, (lock) =>
            lock ? run() : undefined,
          )
        : run();
    void once();
    const again = window.setInterval(() => void once(), AGAIN_MS);
    // The browser says the network is back: at once, not at the next half a minute.
    const back = () => void once();
    window.addEventListener('online', back);
    return () => {
      window.clearInterval(again);
      window.removeEventListener('online', back);
    };
  }, [online, waiting, store, queryClient, t]);

  const refused = list.filter((each) => each.refused);
  if (waiting === 0 && refused.length === 0) return null;
  return (
    <div className="flex flex-col text-sm">
      {waiting > 0 && (
        <p
          role="status"
          className="flex items-center justify-center gap-2 border-b border-line bg-surface px-4 py-2 text-center"
        >
          <CloudUpload aria-hidden className="size-4 shrink-0" />
          {t('outbox.waiting', { count: waiting })}
        </p>
      )}
      {refused.map((each) => (
        <p
          key={each.id}
          role="alert"
          className="flex items-center justify-center gap-2 border-b border-line bg-surface px-4 py-2 text-center text-danger"
        >
          <TriangleAlert aria-hidden className="size-4 shrink-0" />
          {t('outbox.refused', {
            change: t(`outbox.op.${each.operation}` as MessageKey),
            reason: each.refused!,
          })}
          <button
            type="button"
            onClick={() => forget(each.id)}
            aria-label={t('outbox.dismiss')}
            className="inline-flex size-8 items-center justify-center rounded-control"
          >
            <X aria-hidden className="size-4" />
          </button>
        </p>
      ))}
    </div>
  );
}
