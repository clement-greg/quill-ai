export interface OutlineItem {
    id: string;
    text: string;
    level: number; // 0 = section heading, 1 = sub-point
}

export interface ChapterNote {
    id: string;
    noteText: string;
    selectedText: string;
    createdAt: string;
    createdBy?: string;
    createdByName?: string;
    createdByAvatar?: string;  // legacy: base64 data URL; prefer createdBy for new records
    /** Set on a note added at the read-aloud play head (AI chat or Siri) and not
     *  yet pinned into the chapter text: the paragraph it belongs to. The chapter
     *  editor wraps that paragraph in the note's span the next time it has the
     *  chapter open, then clears this. */
    anchor?: ChapterNoteAnchor;
}

/** A paragraph of a chapter, as the read-aloud player counts them. */
export interface ChapterNoteAnchor {
    /** Index in parseContentBlocks() order (the player's paragraph index). */
    blockIndex: number;
    /** The paragraph's text when the note was added, to find it again if the
     *  chapter has changed since. */
    text?: string;
    /** The word being read when the note was added: its UTF-16 offset in the
     *  paragraph's text, and the word itself. Without them (or if the word can't
     *  be found), the note goes on the paragraph's last word. */
    wordOffset?: number;
    word?: string;
}

/** A short quote of an anchored paragraph, for a note's "on …" line. */
export function noteAnchorExcerpt(paragraph: string | undefined, max = 120): string {
    const clean = (paragraph ?? '').replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    const cut = clean.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

import { AuditedRecord } from './audited-record';
import { ChapterDialogue } from './dialogue.model';

export interface Chapter extends AuditedRecord {
    title: string;
    id: string;
    bookId: string;
    content?: string;
    notes?: ChapterNote[];
    sortOrder?: number;
    imageUrl?: string;
    imageThumbnailUrl?: string;
    archived?: boolean;
    outline?: OutlineItem[];
    /** AI-generated 2-3 sentence synopsis of what happens in this chapter.
     * Regenerated on save; powers the "story so far" continuity context. */
    summary?: string;
    /** Hash of the content the current summary was generated from, so we can
     * skip regeneration when the prose hasn't meaningfully changed. */
    summarySourceHash?: string;
    /** Entity (character) whose point of view this chapter is told from. */
    povEntityId?: string;
    /** Where the chapter takes place (free-form: real or fictional place). */
    setting?: string;
    /** When the chapter takes place in story-time (free-form, e.g. "Three days later"). */
    inStoryTime?: string;
    /** Who speaks each line of dialogue, for character voices in read-aloud.
     *  Written by POST /:id/dialogue after a save; a PUT keeps the stored value. */
    dialogue?: ChapterDialogue;
}

export interface ChapterVersion {
    id: string;
    /** Discriminator for the shared `chapter-versions` container, which also
     * holds saved fact-check reports. Absent on snapshots written before the
     * field existed, which are still versions. */
    docType?: 'version';
    chapterId: string;
    savedAt: string;  // ISO timestamp
    content: string;  // HTML snapshot of chapter content
    owner?: string;
    createdBy?: string;
    createdByName?: string;
    createdByAvatar?: string;  // legacy: base64 data URL; prefer createdBy for new records
}