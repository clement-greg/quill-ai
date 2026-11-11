import { Request } from 'express';
import { randomUUID } from 'crypto';
import { getContainer } from './cosmos';
import { readAccessibleItem } from '../middleware/owner-guard';
import { latestListeningPosition, BLOCK_TEXT_MAX } from '../routes/listening.routes';
import { Chapter, ChapterNote, ChapterNoteAnchor, noteAnchorExcerpt } from '../../shared/models/chapter.model';
import { Book } from '../../shared/models/book.model';
import { Series } from '../../shared/models/series.model';

/** Where the read-aloud player is: a paragraph of a chapter of a book. */
export interface Playhead {
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  /** Paragraph index in parseContentBlocks() order; -1 while the chapter title is read. */
  blockIndex: number;
  /** The paragraph's text, when known. */
  text?: string;
}

/**
 * How recently a saved listening position must have been written to count as
 * the player still going, when the caller can't say. The player saves every
 * 10 seconds while playing and straight away when it pauses.
 */
export const RECENT_LISTENING_MS = 2 * 60_000;

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Reads the play head a client sent with a chat request, or null if it's missing or malformed. */
export function parseClientPlayhead(raw: unknown): Playhead | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!isId(p['bookId']) || !isId(p['chapterId'])) return null;
  const blockIndex = p['blockIndex'];
  if (!Number.isInteger(blockIndex) || (blockIndex as number) < -1) return null;
  const paragraph = text(p['text'], BLOCK_TEXT_MAX);
  return {
    bookId: p['bookId'],
    bookTitle: text(p['bookTitle'], 500),
    chapterId: p['chapterId'],
    chapterTitle: text(p['chapterTitle'], 500),
    blockIndex: blockIndex as number,
    ...(paragraph ? { text: paragraph } : {}),
  };
}

/**
 * Where the author's read-aloud player is, if it's going.
 *
 * - `client`: the play head the in-app chat sent (it knows exactly); used when valid.
 * - `playerActive`: from the iPhone, whether its player has a book loaded
 *   (playing, or paused because Siri is listening). true → the last saved
 *   position counts however old; false → there's no play head.
 * - Otherwise the last saved position counts only if it's recent.
 */
export async function currentPlayhead(
  req: Request,
  hints: { client?: unknown; playerActive?: unknown } = {},
  now = Date.now(),
): Promise<Playhead | null> {
  const fromClient = parseClientPlayhead(hints.client);
  if (fromClient) return fromClient;
  if (hints.playerActive === false) return null;

  let saved;
  try {
    saved = await latestListeningPosition(req.user!.sub);
  } catch (err) {
    console.error('[playhead] could not read listening position:', err);
    return null;
  }
  if (!saved) return null;
  if (hints.playerActive !== true && now - saved.updatedAt > RECENT_LISTENING_MS) return null;
  return {
    bookId: saved.bookId,
    bookTitle: saved.bookTitle,
    chapterId: saved.chapterId,
    chapterTitle: saved.chapterTitle,
    blockIndex: saved.blockIndex,
    ...(saved.blockText ? { text: saved.blockText } : {}),
  };
}

/** The anchor for a note at this play head; none while the chapter title is being read. */
export function playheadAnchor(playhead: Playhead): ChapterNoteAnchor | undefined {
  if (playhead.blockIndex < 0) return undefined;
  return { blockIndex: playhead.blockIndex, ...(playhead.text ? { text: playhead.text } : {}) };
}

/** The chapter, if the user owns it or collaborates on its series; null otherwise. */
async function readAccessibleChapter(chapterId: string, req: Request): Promise<Chapter | null> {
  let chapter: Chapter | undefined;
  try {
    ({ resource: chapter } = await getContainer('chapters').item(chapterId, chapterId).read<Chapter>());
  } catch {
    return null;
  }
  if (!chapter || chapter.archived || (chapter as { deleted?: boolean }).deleted) return null;
  if (chapter.owner === req.user!.email) return chapter;
  try {
    const { resource: book } = await getContainer('books').item(chapter.bookId, chapter.bookId).read<Book>();
    if (!book) return null;
    const series = await readAccessibleItem<Series>(getContainer('series'), book.seriesId, book.seriesId, req);
    return series ? chapter : null;
  } catch {
    return null;
  }
}

/**
 * Adds a note to a chapter, pinned to a paragraph when `anchor` is given.
 * Returns the saved chapter's title and notes, or null if the chapter can't be
 * found or isn't the user's. Throws if the save fails.
 */
export async function addChapterNote(
  req: Request,
  chapterId: string,
  noteText: string,
  anchor?: ChapterNoteAnchor,
): Promise<{ chapterId: string; title: string; notes: ChapterNote[] } | null> {
  const chapter = await readAccessibleChapter(chapterId, req);
  if (!chapter) return null;

  const now = new Date().toISOString();
  const email = req.user!.email;
  const note: ChapterNote = {
    id: randomUUID(),
    noteText,
    selectedText: anchor ? noteAnchorExcerpt(anchor.text) : '',
    createdAt: now,
    createdBy: email,
    ...(anchor ? { anchor } : {}),
  };
  const updated: Chapter = {
    ...chapter,
    notes: [...(chapter.notes ?? []), note],
    modifiedBy: email,
    modifiedAt: now,
  };
  delete (updated as { contentVector?: unknown }).contentVector;
  await getContainer('chapters').item(chapter.id, chapter.id).replace<Chapter>(updated);
  return { chapterId: chapter.id, title: chapter.title, notes: updated.notes! };
}

/** System-prompt guidance telling the assistant that notes go at the play head. */
export function playheadGuidance(playhead: Playhead | null): string {
  if (!playhead) return '';
  const where = playhead.chapterTitle ? `chapter "${playhead.chapterTitle}"` : 'a chapter';
  const book = playhead.bookTitle ? ` of "${playhead.bookTitle}"` : '';
  const paragraph = playhead.blockIndex >= 0 && playhead.text
    ? `, at the paragraph beginning "${noteAnchorExcerpt(playhead.text, 80)}"`
    : '';
  return (
    `\n\nREAD-ALOUD PLAYER: The author is listening to ${where}${book}${paragraph}. When they ask to add, ` +
    'make, or save a NOTE without naming a different book or chapter (e.g. "add a note: the dialogue drags ' +
    'here", "note that Mara should already know this"), call add_chapter_note WITHOUT chapterName — the note ' +
    'is pinned to the spot being read. Do not use save_thought or add_book_note for those. When you confirm, ' +
    'say the note was added where they are listening.'
  );
}
