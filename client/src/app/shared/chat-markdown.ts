import { parse as parseMarkdown } from 'marked';
import { ChapterCitation } from '@shared/models';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Turns inline `[n]` markers into clickable citation links and appends a
 * Sources footer, both navigating to the referenced chapter. Links carry a
 * data-chapter-id consumed via event delegation (see chapterIdFromClick).
 */
function decorateCitations(html: string, sources: ChapterCitation[]): string {
  const byNumber = new Map(sources.map(s => [s.n, s]));
  // Match a single [1] or grouped [1][2] / [1, 2] citations and link each number.
  const withInline = html.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?:\s*\[(\d+(?:\s*,\s*\d+)*)\])*/g, match => {
    const numbers = match.match(/\d+/g) ?? [];
    return numbers
      .map(digits => {
        const source = byNumber.get(Number(digits));
        if (!source) return `[${digits}]`;
        const title = escapeHtml(source.title);
        return `<a class="chapter-citation" data-chapter-id="${escapeHtml(source.chapterId)}" title="Go to ${title}">[${digits}]</a>`;
      })
      .join('');
  });
  const links = sources
    .map(s => `<a class="chapter-citation" data-chapter-id="${escapeHtml(s.chapterId)}">${s.n}. ${escapeHtml(s.title)}</a>`)
    .join('');
  return `${withInline}<div class="chat-sources"><span class="chat-sources-label">Sources</span>${links}</div>`;
}

/** Renders assistant message text (markdown + optional citations) to raw HTML. */
export function chatMarkdownToHtml(text: string, sources: ChapterCitation[] = []): string {
  const rawHtml = parseMarkdown(text) as string;
  return sources.length ? decorateCitations(rawHtml, sources) : rawHtml;
}

/** Extracts the chapterId from a click on a citation link, if any. */
export function chapterIdFromClick(event: MouseEvent): string | null {
  const target = (event.target as HTMLElement | null)?.closest('[data-chapter-id]') as HTMLElement | null;
  return target?.dataset['chapterId'] ?? null;
}
