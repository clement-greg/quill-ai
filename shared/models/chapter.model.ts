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
    contentVector?: number[];
    notes?: ChapterNote[];
    sortOrder?: number;
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