/**
 * The chat models an author can pick between, and the AI operations each
 * choice applies to.
 *
 * Settings store the short key (`luna`, `terra`, `sol`), never a deployment
 * name: the server maps each key to the Azure deployment it is configured
 * with, so an environment whose deployments are named differently still
 * honours every stored choice.
 */

export type AiModelKey = 'luna' | 'terra' | 'sol';

export interface AiModelOption {
  key: AiModelKey;
  label: string;
  /** Deployment name this key maps to unless the server is configured otherwise. */
  deployment: string;
  description: string;
}

/** Ordered cheapest to most capable. */
export const AI_MODELS: readonly AiModelOption[] = [
  { key: 'luna', label: 'Luna', deployment: 'gpt-6-luna', description: 'Fast and economical' },
  { key: 'terra', label: 'Terra', deployment: 'gpt-5.6-terra', description: 'Balanced quality and cost' },
  { key: 'sol', label: 'Sol', deployment: 'gpt-6.1-sol', description: 'Most capable, highest cost' },
];

export function isAiModelKey(value: unknown): value is AiModelKey {
  return typeof value === 'string' && AI_MODELS.some(m => m.key === value);
}

export type AiOperation =
  | 'chat'
  | 'chapterDraft'
  | 'beatSheet'
  | 'editorInsert'
  | 'editorReview'
  | 'editorRefine'
  | 'writingScan'
  | 'factCheck'
  | 'chapterAnalysis'
  | 'entityWriting'
  | 'quoteCapture'
  | 'placeSuggestions'
  | 'chapterSummary'
  | 'imagePrompts'
  | 'seriesPrompt'
  | 'titles';

export interface AiOperationOption {
  id: AiOperation;
  label: string;
  description: string;
  /** Cost-conservative default: Luna unless the output is long-form or judgement-heavy. */
  defaultModel: AiModelKey;
}

export const AI_OPERATIONS: readonly AiOperationOption[] = [
  { id: 'chat', label: 'Assistant chat', description: 'Default model for the Quill chat. You can also switch it from the chat itself.', defaultModel: 'luna' },
  { id: 'writingScan', label: 'Grammar & entity scan', description: 'Runs as you type to flag grammar and spot new characters, places and things.', defaultModel: 'luna' },
  { id: 'editorInsert', label: 'Editor AI insert', description: 'Rewording and inserting text from inside the chapter editor.', defaultModel: 'luna' },
  { id: 'editorReview', label: 'Editor review', description: 'Whole-chapter editorial review with suggestions.', defaultModel: 'terra' },
  { id: 'editorRefine', label: 'Editor review follow-up', description: 'Refining a single editor review suggestion.', defaultModel: 'luna' },
  { id: 'factCheck', label: 'Fact check', description: 'Checks a chapter for factual and continuity errors.', defaultModel: 'terra' },
  { id: 'chapterDraft', label: 'Chapter drafting', description: 'Writing a whole chapter of prose.', defaultModel: 'terra' },
  { id: 'beatSheet', label: 'Chapter beat sheet', description: 'Plans the scenes before a chapter is drafted.', defaultModel: 'luna' },
  { id: 'chapterAnalysis', label: 'Chapter analysis', description: 'Extracts timeline events and relationships from a chapter.', defaultModel: 'luna' },
  { id: 'chapterSummary', label: 'Chapter summaries', description: 'Background summaries that give the AI context on earlier chapters.', defaultModel: 'luna' },
  { id: 'entityWriting', label: 'Character writing', description: 'Generated personalities, biographies and descriptions.', defaultModel: 'luna' },
  { id: 'quoteCapture', label: 'Quote capture', description: 'Attributes a captured quote to the character who said it.', defaultModel: 'luna' },
  { id: 'placeSuggestions', label: 'Place suggestions', description: 'Location autocomplete for timeline events.', defaultModel: 'luna' },
  { id: 'imagePrompts', label: 'Image prompts', description: 'Turns chapter text into a prompt for picture generation.', defaultModel: 'luna' },
  { id: 'seriesPrompt', label: 'Series system prompt', description: 'Generates a series-wide instruction prompt.', defaultModel: 'luna' },
  { id: 'titles', label: 'Titles & names', description: 'Names chats and notes.', defaultModel: 'luna' },
];

export type AiModelSettings = Partial<Record<AiOperation, AiModelKey>>;

export const DEFAULT_CHAT_MODEL: AiModelKey = 'luna';

export function isAiOperation(value: unknown): value is AiOperation {
  return typeof value === 'string' && AI_OPERATIONS.some(o => o.id === value);
}

/** The author's choice for an operation, or its default when unset or invalid. */
export function modelKeyFor(settings: AiModelSettings | undefined, op: AiOperation): AiModelKey {
  const chosen = settings?.[op];
  if (isAiModelKey(chosen)) return chosen;
  return AI_OPERATIONS.find(o => o.id === op)!.defaultModel;
}

/** True for a plain object mapping known operations to known model keys. */
export function isAiModelSettings(value: unknown): value is AiModelSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([op, key]) => isAiOperation(op) && isAiModelKey(key));
}
