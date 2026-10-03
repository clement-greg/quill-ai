import { Entity } from './entity.model';

export interface ChatMessageHighlight {
  id: string;
  startOffset: number;
  endOffset: number;
  color: string;
}

/** A retrieved chapter that an assistant answer drew on, for clickable citations. */
export interface ChapterCitation {
  n: number;         // citation number referenced inline as [n]
  chapterId: string; // navigate to /chapters/:chapterId/edit
  title: string;
}

/**
 * A targeted, author-confirmable edit to the chapter being edited, produced by
 * the `propose_chapter_edit` tool. `anchorText` is a verbatim snippet of the
 * current chapter used to locate the edit:
 * - insert: place `newText` `position` (before/after) the anchor.
 * - replace: swap the anchor for `newText`.
 * - delete: remove the anchor.
 * Surfaced as a before→after card in the chat; `applied` flips true once the
 * author confirms and the edit is written into the editor.
 */
export interface ChapterEditProposal {
  kind: 'insert' | 'replace' | 'delete';
  anchorText: string;
  position?: 'before' | 'after';
  newText?: string;
  explanation: string;
  applied?: boolean;
}

/** An image generated earlier in a chat, offered as a profile/gallery picture. */
export interface ChatImage {
  url: string;
  thumbnailUrl: string;
  prompt?: string;
}

/** A story-bible entity the assistant drafted from the conversation. It is
 *  never saved by the assistant: the author reviews it in the entity form and
 *  saves it themselves, at which point `savedEntityId` is set.
 *  With `entityId` set it instead proposes pictures for that existing entity
 *  (`entity` then carries only the proposed profile picture and gallery). */
export interface EntityProposal {
  entityId?: string;
  seriesId: string;
  seriesTitle?: string;
  entity: Pick<Entity, 'name' | 'type'> &
    Partial<Pick<Entity,
      'title' | 'firstName' | 'lastName' | 'nickname' | 'aliases' | 'preferredReference' |
      'biography' | 'personality' | 'gender' | 'race' | 'orientation' |
      'thumbnailUrl' | 'originalUrl' | 'photos'>>;
  /** Every picture generated in the chat, so the author can change the picks. */
  chatImages?: ChatImage[];
  savedEntityId?: string;
}

/** One unique plain-text match the "link references" tool found, e.g. "Mark"
 *  appearing 16 times. `refType` is the entity-reference type to stamp when the
 *  author links it; `status` is set once the author links or skips it. */
export interface EntityLinkGroup {
  text: string;
  refType: string;
  count: number;
  status?: 'linked' | 'skipped';
}

/** An in-chat, step-through session for wrapping plain-text mentions of an
 *  entity in reference markup. Attached to the assistant message that started
 *  it; `index` is the group currently awaiting a decision (=== groups.length
 *  when every match has been linked or skipped). */
export interface EntityLinkSession {
  entityId: string;
  entityName: string;
  groups: EntityLinkGroup[];
  index: number;
}

/** A map an assistant answer surfaced, shown inline as a clickable thumbnail. */
export interface MapPreview {
  id: string;            // open the full map via /maps/:id
  title: string;
  thumbnailUrl?: string; // auto-generated snapshot; absent until one is captured
}

export interface ChatSessionMessage {
  role: 'user' | 'assistant';
  text: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  /** The prompt a generated image was made from, so the assistant can refer to it later. */
  imagePrompt?: string;
  generatingImage?: boolean;
  highlights?: ChatMessageHighlight[];
  sources?: ChapterCitation[];
  maps?: MapPreview[];
  /** A targeted chapter edit the author can apply/refine, rendered as a card. */
  editProposal?: ChapterEditProposal;
  /** An in-chat, step-through session for linking plain-text entity mentions. */
  linkSession?: EntityLinkSession;
  /** A drafted new entity the author reviews in the entity form and saves. */
  entityProposal?: EntityProposal;
  /** Marks an assistant message as a full chapter draft, enabling the
   * Insert / Replace chapter / Revise actions in the UI. */
  kind?: 'chapter-draft';
  /** The beat sheet (scene plan) produced before a chapter draft, shown as a
   * collapsible "Story plan" above the prose. */
  beats?: string;
  /** URL of a lottie animation to display inline after a successful action. */
  lottieUrl?: string;
  /** Names of tools the assistant invoked while producing this message, in call
   * order (deduplicated). Shown as small "Used: …" chips beneath the bubble. */
  toolsUsed?: string[];
  /** ISO-8601 timestamp of when the message was created, shown in the chat. */
  timestamp?: string;
}

export interface ChatSession {
  id: string;
  name: string;
  pinned: boolean;
  folderId?: string | null;
  seriesId?: string | null;
  /** When set, this session is pinned to a specific chapter and appears in its notes panel. */
  chapterId?: string | null;
  /** When set, this session is attached to a story-bible entity: it appears on that
   *  entity's overview and the assistant is grounded in the entity's record. */
  entityId?: string | null;
  messages: ChatSessionMessage[];
  owner?: string;
  deleted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionSummary {
  id: string;
  name: string;
  pinned: boolean;
  folderId?: string | null;
  seriesId?: string | null;
  chapterId?: string | null;
  entityId?: string | null;
  updatedAt: string;
}

export interface ChatFolder {
  id: string;
  name: string;
  parentFolderId?: string | null;
  seriesId?: string | null;
  owner?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FolderFile {
  id: string;
  folderId: string;
  name: string;
  blobName: string;
  contentType: string;
  size: number;
  seriesId?: string | null;
  owner?: string;
  createdAt: string;
  updatedAt: string;
}
