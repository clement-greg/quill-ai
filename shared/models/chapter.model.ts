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
}

import { AuditedRecord } from './audited-record';

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
}

export interface ChapterVersion {
    id: string;
    chapterId: string;
    savedAt: string;  // ISO timestamp
    content: string;  // HTML snapshot of chapter content
    owner?: string;
    createdBy?: string;
    createdByName?: string;
    createdByAvatar?: string;  // legacy: base64 data URL; prefer createdBy for new records
}