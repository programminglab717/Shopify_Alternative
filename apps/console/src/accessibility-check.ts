import { afterEach, vi } from 'vitest';
import { accessibilityProblems } from './accessibility';

// Accessibility checked as the tests run (design §8): the first screen each test file renders is
// read by axe once its test is done, and any rule it breaks fails that test. Testing Library's
// cleanup empties the page before any hook of this file runs, so the page is kept as it was the
// moment before. Once a file, not once a test: axe takes a moment, and the suite runs on busy
// machines.

const kept: { html: string | null; checked: boolean } = { html: null, checked: false };

vi.mock('@testing-library/react', async (original) => {
  const real = await original<typeof import('@testing-library/react')>();
  return {
    ...real,
    cleanup: () => {
      if (!kept.checked && document.body.innerHTML.trim()) kept.html = document.body.innerHTML;
      real.cleanup();
    },
  };
});

afterEach(async () => {
  // Files of no screens run without a page at all.
  if (typeof document === 'undefined' || kept.checked) return;
  // The page as cleanup found it; or, where this runs before cleanup, the page itself.
  const html = kept.html;
  kept.html = null;
  const showing = document.body.innerHTML.trim() !== '';
  if (!html && !showing) return;
  kept.checked = true;
  const page = showing ? null : document.createElement('div');
  if (page) {
    page.innerHTML = html!;
    document.body.appendChild(page);
  }
  try {
    const problems = await accessibilityProblems(page ?? document.body);
    if (problems.length > 0) {
      throw new Error(`The screen breaks accessibility rules:\n${problems.join('\n')}`);
    }
  } finally {
    page?.remove();
  }
});
