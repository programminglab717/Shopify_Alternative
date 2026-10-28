import { randomInt } from 'node:crypto';
import type { ExperimentDoc } from '@hatti/storefront-data';

// Theme experiments (OS-22, ADR-866): a shop's running experiment shows a share of its shoppers
// a draft of its theme. A shopper is put in an arm on the first page they're shown, and keeps it
// in a cookie for the experiment's life, so each sees one theme throughout; robots are always
// shown the live theme, as search engines must be. Pages of the draft are the shopper's own,
// never kept at the edge.

export const EXPERIMENT_COOKIE = 'hatti_ab';

/** Long enough for any experiment: the longest runs thirty days. */
const EXPERIMENT_COOKIE_SECONDS = 31 * 86_400;

export interface ExperimentArm {
  id: string;
  arm: 'a' | 'b';
  /** Put in the arm by this request: its answer keeps the arm in the cookie. */
  assigned: boolean;
}

/**
 * The arm of the running experiment `experiment` a shopper is in: as their cookie keeps it, for
 * this experiment, or drawn now by its share; the live theme's for a robot. Null for no
 * experiment.
 */
export function experimentArm(
  experiment: ExperimentDoc | undefined,
  cookie: string | null,
  robot: boolean,
  draw: (below: number) => number = randomInt,
): ExperimentArm | null {
  if (!experiment) return null;
  if (robot) return { id: experiment.id, arm: 'a', assigned: false };
  const [id, arm] = (cookie ?? '').split('.');
  if (id === experiment.id && (arm === 'a' || arm === 'b')) {
    return { id, arm, assigned: false };
  }
  return { id: experiment.id, arm: draw(100) < experiment.share ? 'b' : 'a', assigned: true };
}

/** The cookie keeping the shopper's arm of an experiment. */
export function experimentCookie(arm: ExperimentArm, options: { secure: boolean }): string {
  return `${EXPERIMENT_COOKIE}=${arm.id}.${arm.arm}; Max-Age=${EXPERIMENT_COOKIE_SECONDS}; Path=/; SameSite=Lax${options.secure ? '; Secure' : ''}`;
}
