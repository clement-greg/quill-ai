import { AuditedRecord } from './audited-record';

export interface TimelineEventPhoto {
    url: string;
    thumbnailUrl: string;
}

export interface TimelineEvent extends AuditedRecord {
    id: string;
    entityId: string;
    seriesId: string;
    name: string;
    /** Free-form timeframe, often relative to other events (e.g. "Three years before the war"). */
    timeframe?: string;
    description?: string;
    /** Relative position on the timeline. */
    sortOrder?: number;
    photo?: TimelineEventPhoto;
    /** 'chapter' events are auto-generated from chapter content via timeline extraction. */
    source?: 'manual' | 'chapter';
    chapterId?: string;
}

/** The editable fields of a timeline event that chapter extraction can propose. */
export interface TimelineEventFields {
    name: string;
    timeframe?: string;
    description?: string;
}

/** A new event the LLM found in the chapter. */
export interface TimelineAddProposal extends TimelineEventFields {
    entityId: string;
    entityName: string;
    photo?: TimelineEventPhoto;
}

/** A chapter-sourced event whose underlying facts changed substantively. */
export interface TimelineUpdateProposal {
    eventId: string;
    entityId: string;
    entityName: string;
    current: TimelineEventFields;
    proposed: TimelineEventFields;
    reason?: string;
}

/** A chapter-sourced event no longer supported by the chapter text. */
export interface TimelineRemoveProposal {
    eventId: string;
    entityId: string;
    entityName: string;
    current: TimelineEventFields;
    reason?: string;
}

/** Result of analyzing a chapter for timeline changes. Nothing is persisted until applied. */
export interface TimelineExtractionResult {
    adds: TimelineAddProposal[];
    updates: TimelineUpdateProposal[];
    removes: TimelineRemoveProposal[];
}

/** The proposals the user accepted, sent back to be persisted. */
export interface ApplyTimelineProposalsRequest {
    chapterId: string;
    adds: TimelineAddProposal[];
    updates: TimelineUpdateProposal[];
    removes: TimelineRemoveProposal[];
}

export interface ApplyTimelineProposalsResult {
    added: number;
    updated: number;
    removed: number;
}
