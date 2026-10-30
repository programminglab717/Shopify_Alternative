import { afterEach, describe, expect, it } from 'vitest';
import { accessibilityProblems } from './accessibility';

describe('The accessibility check the tests run (design §8)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /** A screen of `html`, on the page while it is read. */
  async function problemsOf(html: string) {
    const screen = document.createElement('div');
    screen.innerHTML = html;
    document.body.appendChild(screen);
    const problems = await accessibilityProblems(screen);
    screen.remove();
    return problems;
  }

  it('finds a field without a label, a button without a name and a picture without words', async () => {
    const problems = await problemsOf(
      '<main><h1>Products</h1><input type="text"><button><svg></svg></button><img src="a.png"></main>',
    );
    expect(problems.map((each) => each.split(' ')[1])).toEqual(
      expect.arrayContaining(['label', 'button-name', 'image-alt']),
    );
  });

  it('passes a screen that names everything, and leaves what tests cannot judge', async () => {
    expect(
      await problemsOf(
        '<main><h1>Products</h1><label>Title <input type="text"></label>' +
          '<button aria-label="Delete"><svg aria-hidden="true"></svg></button>' +
          '<img src="a.png" alt="A red kurta"><nav aria-label="Main"></nav><nav aria-label="Main"></nav></main>',
      ),
    ).toEqual([]);
  });

  it('finds headings that skip a level', async () => {
    const problems = await problemsOf('<main><h1>Orders</h1><h3>Today</h3></main>');
    expect(problems.map((each) => each.split(' ')[1])).toEqual(['heading-order']);
  });
});
