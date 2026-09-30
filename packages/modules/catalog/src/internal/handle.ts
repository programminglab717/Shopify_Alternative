const MAX_HANDLE_LENGTH = 100;

/**
 * URL handle from a title: lowercase ASCII words joined by hyphens.
 * "Lawn 3-Piece Suit (Unstitched)" → "lawn-3-piece-suit-unstitched".
 * Titles without Latin letters or digits (e.g. Urdu only) give an empty string.
 */
export function toHandle(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_HANDLE_LENGTH)
    .replace(/^-+|-+$/g, '');
}

/** Candidates for a free handle: base, base-2, base-3, … */
export function handleCandidate(base: string, attempt: number): string {
  if (attempt === 0) return base;
  const suffix = `-${attempt + 1}`;
  return `${base.slice(0, MAX_HANDLE_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/**
 * What a product's or collection's update event says of its handle: the one before, when it
 * changed, and whether the change asked for the old address to send shoppers to the new one
 * (ADR-053).
 */
export function movedFrom(
  handle: string,
  changed: readonly string[],
  redirectNewHandle: boolean | null | undefined,
): { previousHandle?: string; redirectNewHandle?: true } {
  if (!changed.includes('handle')) return {};
  return redirectNewHandle
    ? { previousHandle: handle, redirectNewHandle }
    : { previousHandle: handle };
}
