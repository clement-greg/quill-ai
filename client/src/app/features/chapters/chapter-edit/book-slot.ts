import { Chapter, ChapterNote, OutlineItem } from '@shared/models/chapter.model';

/** One chapter's state while the full book is open. */
export interface BookSlot {
  chapter: Chapter;
  /** Latest HTML (live editor content is read back on every switch/save). */
  content: string;
  notes: ChapterNote[];
  outline: OutlineItem[];
  /** Has an unsaved local draft. */
  hasDraft: boolean;
  /** Content as of the last server save. */
  savedContent: string;
  /** Content as of the last local draft write. */
  draftContent: string;
  taskCheckBaseline: string | null;
}

export function makeSlot(
  chapter: Chapter, content: string, notes: ChapterNote[], outline: OutlineItem[],
  hasDraft: boolean, savedContent: string,
): BookSlot {
  return {
    chapter: { ...chapter, content }, content, notes, outline, hasDraft, savedContent,
    draftContent: hasDraft ? content : savedContent, taskCheckBaseline: savedContent,
  };
}

/** The book chapters a save should write: every chapter marked dirty, plus any
 *  with an unsaved local draft (so "Unsaved draft" always means Save has work). */
export function slotsToSave(dirtyIds: ReadonlySet<string>, slots: Iterable<BookSlot>): BookSlot[] {
  return [...slots].filter(sl => sl.hasDraft || dirtyIds.has(sl.chapter.id));
}
