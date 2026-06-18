/**
 * Types for the "Quill Editor" AI review feature: an editorial pass that walks a
 * chapter and streams concrete edit suggestions the author can accept or reject.
 *
 * Suggestions are EPHEMERAL — generated fresh per run and never persisted. The
 * model returns one suggestion per line (JSONL) so the client can surface them
 * progressively as the review "walks" the chapter.
 */

/** What kind of editorial concern a suggestion addresses. The first group is
 * copy/line editing; the rest are the developmental, continuity and voice
 * lenses added in the full editorial pass. */
export type SuggestionCategory =
  // Copy / line editing
  | 'grammar'
  | 'punctuation'
  | 'word-choice'
  | 'flow'
  | 'clarity'
  | 'repetition'
  // Developmental / content
  | 'pacing'
  | 'description'
  | 'dialogue'
  | 'tension'
  | 'plot'
  // Consistency / continuity
  | 'continuity'
  // Style / voice
  | 'voice'
  | 'character'
  | 'other';

/** How strongly the editor feels about the change. The client hides `low`
 * by default so a clean chapter isn't swamped with nitpicks. */
export type SuggestionSeverity = 'low' | 'medium' | 'high';

/**
 * The edit operation. Phase 1 only emits `replace`; `insert`/`delete`/`comment`
 * are reserved for later phases (developmental notes that aren't literal swaps).
 */
export type SuggestionType = 'replace' | 'insert' | 'delete' | 'comment';

/**
 * One editorial suggestion anchored to a block of the chapter. `originalText`
 * is the EXACT substring within `blockIndex` the edit targets — the client
 * locates it by walking the block's text nodes, so it survives inline spans
 * (entity references, etc.).
 */
export interface EditorSuggestion {
  /** Server-assigned unique id. */
  id: string;
  /** Index of the block (top-level paragraph) this suggestion applies to. */
  blockIndex: number;
  /** Exact substring within the block that the suggestion targets. */
  originalText: string;
  /** Replacement prose (for `replace`/`insert`). Omitted for `comment`. */
  replacementText?: string;
  type: SuggestionType;
  category: SuggestionCategory;
  severity: SuggestionSeverity;
  /** Short human-readable rationale shown in the suggestion card. */
  reason: string;
}

/** A single block of chapter prose sent to the editor for review. */
export interface EditorReviewBlock {
  index: number;
  text: string;
}

/** Request body for POST /api/chapter-editor-review. */
export interface EditorReviewRequest {
  chapterId: string;
  blocks: EditorReviewBlock[];
}
