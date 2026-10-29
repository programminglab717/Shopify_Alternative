import { randomInt } from 'node:crypto';
import {
  EXPERIMENT_ARMS,
  type ExperimentArm as ArmName,
  type ExperimentDoc,
} from '@hatti/storefront-data';

// Theme experiments (OS-22, ADR-866): a shop's running experiment shows a share of its shoppers
// a draft of its theme. A shopper is put in an arm on the first page they're shown, and keeps it
// in a cookie for the experiment's life, so each sees one theme throughout; robots are always
// shown the live theme, as search engines must be. Pages of the draft are the shopper's own,
// never kept at the edge. An experiment of several drafts gives each its share in turn, arms b, c
// and d, the rest the live theme's (ADR-931). A draft Hatti stopped shows its shoppers the live
// theme, counting them in no arm, and its share of new shoppers goes to the live theme (ADR-939).

export const EXPERIMENT_COOKIE = 'hatti_ab';

/** Long enough for any experiment: the longest runs thirty days. */
const EXPERIMENT_COOKIE_SECONDS = 31 * 86_400;

export interface ExperimentArm {
  id: string;
  arm: ArmName;
  /** Put in the arm by this request: its answer keeps the arm in the cookie. */
  assigned: boolean;
  /** In a stopped draft's arm: shown the live theme, and counted in none (ADR-939). */
  uncounted?: true;
}

/** The arms of `experiment`: the live theme's, and one for each of its drafts. */
export function armsOf(experiment: ExperimentDoc): ArmName[] {
  return EXPERIMENT_ARMS.slice(0, 2 + Math.min(experiment.others?.length ?? 0, 2));
}

/**
 * The arm of the running experiment `experiment` a shopper is in: as their cookie keeps it, for
 * this experiment, or drawn now by its share, each draft's in turn; the live theme's for a robot.
 * Null for no experiment.
 */
export function experimentArm(
  experiment: ExperimentDoc | undefined,
  cookie: string | null,
  robot: boolean,
  draw: (below: number) => number = randomInt,
): ExperimentArm | null {
  if (!experiment) return null;
  if (robot) return { id: experiment.id, arm: 'a', assigned: false };
  const arms = armsOf(experiment);
  const stopped = (arm: ArmName) => (experiment.stopped as ArmName[] | undefined)?.includes(arm);
  const [id, kept] = (cookie ?? '').split('.');
  const arm = arms.find((each) => each === kept);
  if (id === experiment.id && arm) {
    return stopped(arm)
      ? { id, arm: 'a', assigned: false, uncounted: true }
      : { id, arm, assigned: false };
  }
  // 0 to 99: below the first draft's share its, below that and the second's the second's, and so
  // on, each draft its own share (ADR-952); a stopped draft's share the live theme's.
  const shares = experiment.shares ?? arms.slice(1).map(() => experiment.share);
  const point = draw(100);
  let below = 0;
  const at = shares.findIndex((share) => point < (below += share));
  const drawn = at >= 0 ? (arms[at + 1] ?? 'a') : 'a';
  return { id: experiment.id, arm: stopped(drawn) ? 'a' : drawn, assigned: true };
}

/** The cookie keeping the shopper's arm of an experiment. */
export function experimentCookie(arm: ExperimentArm, options: { secure: boolean }): string {
  return `${EXPERIMENT_COOKIE}=${arm.id}.${arm.arm}; Max-Age=${EXPERIMENT_COOKIE_SECONDS}; Path=/; SameSite=Lax${options.secure ? '; Secure' : ''}`;
}
