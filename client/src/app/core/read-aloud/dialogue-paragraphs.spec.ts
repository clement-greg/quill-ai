import { dialogueBlocks } from './dialogue-paragraphs';
import { parseContentBlocks } from '@app/features/chapters/chapter-edit/chapter-content-blocks';

describe('dialogueBlocks', () => {
  const html =
    '<p>The rain kept on.</p>' +
    '<p>“Come in,” Ann said.   <em>He looks tired,</em> she thought.</p>' +
    '<div><span>"Thanks."</span> Bob sat. It was <i>very</i> late.</div>';

  it('lines up with the read-aloud paragraphs', () => {
    expect(dialogueBlocks(html).map(b => b.text)).toEqual(parseContentBlocks(html).map(b => b.text));
  });

  it('finds quotes and italic thoughts, but not italic emphasis', () => {
    const blocks = dialogueBlocks(html);
    expect(blocks[0]!.spans).toEqual([]);
    expect(blocks[0]!.key).toBeUndefined();
    const spoken = (i: number) => blocks[i]!.spans.map(s => blocks[i]!.text.slice(s.start, s.end));
    expect(spoken(1)).toEqual(['“Come in,”', 'He looks tired,']);
    expect(spoken(2)).toEqual(['"Thanks."']);
    expect(blocks[1]!.key).toBeTruthy();
  });

  it('gives an edited quote a new key, and an untouched one the same key', () => {
    const before = dialogueBlocks(html);
    const after = dialogueBlocks(html.replace('Come in', 'Come inside'));
    expect(after[1]!.key).not.toBe(before[1]!.key);
    expect(after[2]!.key).toBe(before[2]!.key);
  });

  it('counts italic text as a thought only when it is in italics', () => {
    const plain = dialogueBlocks('<p>He looks tired, she thought.</p>');
    expect(plain[0]!.spans).toEqual([]);
    const styled = dialogueBlocks('<p><span style="font-style: italic">He looks tired,</span> she thought.</p>');
    expect(styled[0]!.spans.length).toBe(1);
  });
});
