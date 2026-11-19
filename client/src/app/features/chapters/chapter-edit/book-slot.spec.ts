import { describe, expect, it } from 'vitest';
import { Chapter } from '@shared/models/chapter.model';
import { makeSlot, slotsToSave } from './book-slot';

const chapter = (id: string) => ({ id, title: id, bookId: 'b' }) as Chapter;

describe('slotsToSave', () => {
  it('includes chapters marked dirty', () => {
    const a = makeSlot(chapter('a'), 'x', [], [], false, 'x');
    const b = makeSlot(chapter('b'), 'y', [], [], false, 'y');
    expect(slotsToSave(new Set(['b']), [a, b])).toEqual([b]);
  });

  it('includes chapters with an unsaved draft even when not marked dirty', () => {
    const a = makeSlot(chapter('a'), 'edited', [], [], true, 'saved');
    expect(slotsToSave(new Set(), [a])).toEqual([a]);
  });

  it('returns nothing when no chapter is dirty or drafted', () => {
    const a = makeSlot(chapter('a'), 'x', [], [], false, 'x');
    expect(slotsToSave(new Set(), [a])).toEqual([]);
  });

  it('ignores dirty ids with no loaded slot and lists each chapter once', () => {
    const a = makeSlot(chapter('a'), 'edited', [], [], true, 'saved');
    expect(slotsToSave(new Set(['a', 'gone']), [a])).toEqual([a]);
  });
});
