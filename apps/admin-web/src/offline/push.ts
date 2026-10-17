/**
 * What the service worker shows of a push (APP-03, ADR-506): the core sends a title, a body, the
 * admin's page it is about and a tag, the words already in the member's language. A newer push
 * of the same tag replaces the one still showing.
 */

export interface ShownNotification {
  title: string;
  options: {
    body: string;
    tag?: string;
    icon: string;
    badge: string;
    dir: 'auto';
    data: { url: string };
  };
}

/** The notification to show for a push's `data`, or null for one that is not the core's. */
export function notificationOf(data: unknown): ShownNotification | null {
  if (typeof data !== 'object' || data === null) return null;
  const { title, body, url, tag } = data as Record<string, unknown>;
  if (typeof title !== 'string' || title === '') return null;
  return {
    title: title.slice(0, 200),
    options: {
      body: typeof body === 'string' ? body.slice(0, 500) : '',
      ...(typeof tag === 'string' && tag !== '' && { tag }),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Its words in English or Urdu: the browser sets their direction.
      dir: 'auto',
      data: { url: typeof url === 'string' ? url : '/' },
    },
  };
}

/**
 * The admin's page a notification opens: its path on the admin's own origin, never another
 * site's, whatever the push said.
 */
export function pageFor(url: unknown, origin: string): string {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return `${origin}/`;
  try {
    const page = new URL(url, origin);
    return page.origin === origin ? page.href : `${origin}/`;
  } catch {
    return `${origin}/`;
  }
}
