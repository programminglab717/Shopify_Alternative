/**
 * What gives a shopper's comment away as spam (OS-07, ADR-619), read from the comment alone:
 * links in its name, markup for links in its text, more links than a comment needs, or the words
 * spam is sold with. A comment with any is kept for the shop as spam, not shown nor held.
 */
export type SpamSign = 'LINK_IN_NAME' | 'LINK_MARKUP' | 'LINKS' | 'WORDS';

export const COMMENT_SPAM = {
  /** How many links a comment may carry before it reads as spam. */
  links: 2,
  /**
   * How long a comment's text must be for a second of it within the day to read as spam: shorter
   * ones, "Thank you!", shoppers write alike.
   */
  repeated: 40,
} as const;

const LINK = /\b(?:https?:\/\/|www\.)\S+/giu;
/** BBCode's and HTML's links, which a comment of plain text has no use for. */
const MARKUP = /\[(?:url|link)[=\]]|<a\s/iu;
/** What spam sells, as whole words. */
const WORDS =
  /\b(?:viagra|cialis|casino|porn|xxx|escorts?|backlinks?|seo services|payday loans?|forex signals|crypto investment|bitcoin investment|betting tips|replica watches|onlyfans)\b/iu;

/** The signs of spam in a comment's name and text, as kept; none for a comment that reads clean. */
export function spamSignsOf(comment: { author: string; body: string }): SpamSign[] {
  const signs: SpamSign[] = [];
  if (comment.author.match(LINK) || /\.(?:com|net|org|info|xyz|ru)\b/iu.test(comment.author)) {
    signs.push('LINK_IN_NAME');
  }
  if (MARKUP.test(comment.body)) signs.push('LINK_MARKUP');
  if ((comment.body.match(LINK) ?? []).length > COMMENT_SPAM.links) signs.push('LINKS');
  if (WORDS.test(`${comment.author} ${comment.body}`)) signs.push('WORDS');
  return signs;
}
