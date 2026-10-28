import type { Translate } from '../i18n/locale';

/** A scope as a merchant reads it: "See and change orders" for write_orders. */
export function scopeLabel(scope: string, t: Translate): string {
  const [, access, resource] = /^(read|write)_(.+)$/.exec(scope) ?? [];
  if (!access || !resource) return scope;
  return t(access === 'write' ? 'oauth.write' : 'oauth.read', {
    resource: resource.replace(/_/g, ' '),
  });
}
