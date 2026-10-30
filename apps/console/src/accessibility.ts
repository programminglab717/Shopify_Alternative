import axe from 'axe-core';

// What axe finds wrong on a screen (design §8), for the tests to fail on, as the admin's tests do
// (apps/admin-web/src/accessibility.ts): each rule it breaks, how badly, and the first few
// elements that break it.

/** Rules the tests cannot judge, or that judge the shop's own words. */
const NOT_JUDGED = {
  // Tests lay nothing out, so there are no colours to compare: the tokens' own tests check the
  // contrast of every pair the design system uses.
  'color-contrast': { enabled: false },
  // A test renders a screen alone, often a part of one, outside the shell's landmarks.
  region: { enabled: false },
  // The side bar and the phone's bar at the foot are the one main navigation, each shown at a
  // width the other is hidden at; the tests, without styles, see both.
  'landmark-unique': { enabled: false },
  // A photo's description is the merchant's own words, which may say what the page says.
  'image-redundant-alt': { enabled: false },
};

/** The rules `root` breaks, each said in a line or more; none where it breaks none. */
export async function accessibilityProblems(root: Element): Promise<string[]> {
  // An embedded app's or a theme's preview frame is its own page, not the admin's.
  const { violations } = await axe.run(root, {
    rules: NOT_JUDGED,
    iframes: false,
    // What passes is not needed, and is most of axe's time.
    resultTypes: ['violations'],
  });
  return violations.map(
    (each) =>
      `- ${each.id} (${each.impact ?? 'minor'}): ${each.help}\n  ${each.nodes
        .slice(0, 3)
        .map((node) => node.html.slice(0, 200))
        .join('\n  ')}`,
  );
}
