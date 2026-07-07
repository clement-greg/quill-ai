import { ChapterCitation } from '@shared/models';
import { chatMarkdownToHtml, chapterIdFromClick } from './chat-markdown';

const sources: ChapterCitation[] = [
  { n: 1, chapterId: 'ch-1', title: 'The Beginning' },
  { n: 2, chapterId: 'ch-2', title: 'The <Middle> & "End"' },
];

describe('chatMarkdownToHtml', () => {
  it('renders markdown without citations when no sources are given', () => {
    const html = chatMarkdownToHtml('Hello **world**');
    expect(html).toContain('<strong>world</strong>');
    expect(html).not.toContain('chat-sources');
  });

  it('turns an inline [n] marker into a citation link', () => {
    const html = chatMarkdownToHtml('See [1] for details.', sources);
    expect(html).toContain('data-chapter-id="ch-1"');
    expect(html).toContain('title="Go to The Beginning"');
    expect(html).toContain('>[1]</a>');
  });

  it('links each number in grouped [1][2] citations', () => {
    const html = chatMarkdownToHtml('As shown [1][2].', sources);
    expect(html).toContain('data-chapter-id="ch-1"');
    expect(html).toContain('data-chapter-id="ch-2"');
  });

  it('links each number in comma-form [1, 2] citations', () => {
    const html = chatMarkdownToHtml('As shown [1, 2].', sources);
    expect(html).toContain('>[1]</a>');
    expect(html).toContain('>[2]</a>');
  });

  it('leaves markers with no matching source as plain text', () => {
    const html = chatMarkdownToHtml('Unknown [7] reference.', sources);
    expect(html).toContain('[7]');
    expect(html).not.toContain('data-chapter-id="ch-7"');
    // Only the sources footer contains links.
    expect(html.match(/<a class="chapter-citation"/g)?.length).toBe(sources.length);
  });

  it('escapes HTML in source titles', () => {
    const html = chatMarkdownToHtml('See [2].', sources);
    expect(html).toContain('The &lt;Middle&gt; &amp; &quot;End&quot;');
    expect(html).not.toContain('<Middle>');
  });

  it('appends a Sources footer listing every source', () => {
    const html = chatMarkdownToHtml('No inline markers here.', sources);
    expect(html).toContain('chat-sources');
    expect(html).toContain('1. The Beginning');
    expect(html).toContain('data-chapter-id="ch-2"');
  });
});

describe('chapterIdFromClick', () => {
  function clickEventOn(target: Element | null): MouseEvent {
    return { target } as unknown as MouseEvent;
  }

  it('returns the chapter id when a citation link (or its child) is clicked', () => {
    const container = document.createElement('div');
    container.innerHTML = '<a class="chapter-citation" data-chapter-id="ch-9"><span>[1]</span></a>';
    const inner = container.querySelector('span')!;
    expect(chapterIdFromClick(clickEventOn(inner))).toBe('ch-9');
  });

  it('returns null for clicks outside a citation link', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>plain text</p>';
    expect(chapterIdFromClick(clickEventOn(container.querySelector('p')))).toBeNull();
    expect(chapterIdFromClick(clickEventOn(null))).toBeNull();
  });
});
