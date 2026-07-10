// Target size for a content chunk, in characters. ~1200 chars ≈ ~400 tokens,
// which keeps each embedding focused on a small passage while still carrying
// enough context to be meaningful for retrieval.
const TARGET_CHUNK_CHARS = 1200;

/** Strips HTML tags from a fragment and collapses whitespace. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits chapter HTML into paragraph-sized plain-text units. Block-level
 * boundaries (paragraphs, divs, list items, headings, line breaks) become unit
 * boundaries; tags are then stripped from each unit and empty units dropped.
 */
function splitIntoParagraphs(html: string): string[] {
  return html
    // Turn closing/standalone block tags into a delimiter we can split on.
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n\n')
    .split(/\n{2,}/)
    .map(stripTags)
    .filter(unit => unit.length > 0);
}

/** Hard-splits an oversized paragraph into <= maxChars pieces on word boundaries. */
function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  const pieces: string[] = [];
  const words = paragraph.split(' ');
  let current = '';
  for (const word of words) {
    if (current && current.length + 1 + word.length > maxChars) {
      pieces.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Chunks chapter HTML into reasonably sized plain-text passages for embedding.
 * Whole paragraphs are greedily packed up to TARGET_CHUNK_CHARS; a paragraph
 * that alone exceeds the budget is hard-split on word boundaries. Returns an
 * empty array for empty/whitespace-only content.
 */
export function chunkHtmlContent(html: string | undefined | null, targetChars = TARGET_CHUNK_CHARS): string[] {
  if (!html) return [];

  const paragraphs = splitIntoParagraphs(html);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > targetChars) {
      flush();
      chunks.push(...splitLongParagraph(paragraph, targetChars));
      continue;
    }
    if (current && current.length + 2 + paragraph.length > targetChars) {
      flush();
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();

  return chunks;
}
