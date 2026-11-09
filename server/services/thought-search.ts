import { getContainer } from './cosmos';
import { generateEmbedding } from './embeddings';
import { Thought } from '../../shared/models/thought.model';

const NOT_DELETED = '(NOT IS_DEFINED(c.deleted) OR c.deleted = false)';
const LIGHT_FIELDS = 'c.id, c.title, c.content, c.tags, c.createdAt, c.modifiedAt';

/** Builds the text a thought is embedded from: title (if any) prepended to content. */
export function thoughtEmbeddingText(thought: Pick<Thought, 'title' | 'content'>): string {
  return thought.title ? `${thought.title}\n\n${thought.content}` : thought.content;
}

export interface ThoughtSearchHit {
  id: string;
  title?: string;
  content: string;
  tags: string[];
  modifiedAt?: string;
  /** How the thought matched: every query word appears in it, or it is close in meaning. */
  match: 'keyword' | 'semantic';
  /** Cosine similarity for semantic hits (higher is closer). */
  score?: number;
}

type LightThought = Pick<Thought, 'id' | 'title' | 'content' | 'tags' | 'createdAt' | 'modifiedAt'>;

/** Lower-cased words of 2+ characters, for keyword matching. */
export function searchWords(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w.length >= 2))];
}

/** How many of the words appear in the thought's title, content, or tags. */
export function keywordHits(thought: Pick<Thought, 'title' | 'content' | 'tags'>, words: string[]): number {
  const haystack = `${thought.title ?? ''}\n${thought.content}\n${(thought.tags ?? []).join(' ')}`.toLowerCase();
  return words.filter((w) => haystack.includes(w)).length;
}

/** Whether the thought carries every one of the tags (case-insensitive). */
export function hasAllTags(thought: Pick<Thought, 'tags'>, tags: string[]): boolean {
  if (!tags.length) return true;
  const own = new Set((thought.tags ?? []).map((t) => t.toLowerCase()));
  return tags.every((t) => own.has(t.toLowerCase()));
}

/**
 * Embeds up to `max` of the owner's thoughts that have no vector yet — older
 * thoughts saved from chat, or ones whose embedding call failed — so semantic
 * search can find them. Returns how many were filled in.
 */
export async function backfillThoughtVectors(owner: string, max = 25): Promise<number> {
  const container = getContainer('thought-items');
  const { resources } = await container.items
    .query<Thought>({
      query: `SELECT TOP ${max} * FROM c WHERE c.owner = @owner AND ${NOT_DELETED} AND NOT IS_DEFINED(c.contentVector)`,
      parameters: [{ name: '@owner', value: owner }],
    })
    .fetchAll();
  let filled = 0;
  for (const thought of resources) {
    if (thought.contentVector || !thought.content?.trim()) continue;
    try {
      const contentVector = await generateEmbedding(thoughtEmbeddingText(thought));
      await container.item(thought.id, thought.id).replace<Thought>({ ...thought, contentVector });
      filled++;
    } catch (err) {
      console.warn('thought-search: backfill embedding failed for %s:', thought.id, err);
      break; // The embedding service is likely down; don't hammer it.
    }
  }
  return filled;
}

async function semanticSearch(
  owner: string,
  query: string,
  topK: number,
): Promise<(LightThought & { score: number })[]> {
  const vector = await generateEmbedding(query);
  // `true` forces brute-force distance: this container has no dedicated vector
  // index (see cosmos.ts). SELECT and ORDER BY must use the same expression.
  const distance = 'VectorDistance(c.contentVector, @vec, true)';
  const { resources } = await getContainer('thought-items')
    .items.query<LightThought & { score: number }>({
      query:
        `SELECT TOP ${topK} ${LIGHT_FIELDS}, ${distance} AS score FROM c ` +
        `WHERE c.owner = @owner AND ${NOT_DELETED} AND IS_DEFINED(c.contentVector) ORDER BY ${distance}`,
      parameters: [
        { name: '@owner', value: owner },
        { name: '@vec', value: vector },
      ],
    })
    .fetchAll();
  return resources;
}

async function allLightThoughts(owner: string): Promise<LightThought[]> {
  const { resources } = await getContainer('thought-items')
    .items.query<LightThought>({
      query: `SELECT ${LIGHT_FIELDS} FROM c WHERE c.owner = @owner AND ${NOT_DELETED} ORDER BY c.modifiedAt DESC`,
      parameters: [{ name: '@owner', value: owner }],
    })
    .fetchAll();
  return resources;
}

function toHit(t: LightThought, match: ThoughtSearchHit['match'], score?: number): ThoughtSearchHit {
  return {
    id: t.id,
    title: t.title,
    content: t.content,
    tags: t.tags ?? [],
    modifiedAt: t.modifiedAt ?? t.createdAt,
    match,
    ...(score === undefined ? {} : { score }),
  };
}

/**
 * Finds the owner's thoughts for a free-text query, combining meaning-based
 * (vector) and literal word matching. Ordering: thoughts containing every query
 * word first (newest first), then the closest in meaning, then partial word
 * matches. Optionally restricted to thoughts carrying all of `tags`. An empty
 * query with tags lists the tagged thoughts, newest first.
 *
 * Semantic search failing (e.g. the embedding service is down) degrades to
 * keyword-only results rather than throwing.
 */
export async function searchThoughts(
  owner: string,
  query: string,
  opts: { topK?: number; tags?: string[] } = {},
): Promise<ThoughtSearchHit[]> {
  const topK = Math.max(1, Math.min(25, Math.floor(opts.topK ?? 8)));
  const tags = opts.tags ?? [];
  const words = searchWords(query);

  try {
    await backfillThoughtVectors(owner);
  } catch (err) {
    console.warn('thought-search: backfill skipped:', err);
  }

  const [all, semantic] = await Promise.all([
    allLightThoughts(owner),
    query.trim()
      ? semanticSearch(owner, query, tags.length ? 50 : topK).catch((err) => {
          console.warn('thought-search: semantic search failed, using keywords only:', err);
          return [];
        })
      : Promise.resolve([]),
  ]);

  const candidates = all.filter((t) => hasAllTags(t, tags));
  if (!words.length && !semantic.length) {
    return candidates.slice(0, topK).map((t) => toHit(t, 'keyword'));
  }

  const scored = candidates.map((t) => ({ t, hits: keywordHits(t, words) }));
  const full = scored.filter((s) => words.length && s.hits === words.length).map((s) => toHit(s.t, 'keyword'));
  const partial = scored
    .filter((s) => s.hits > 0 && s.hits < words.length)
    .sort((a, b) => b.hits - a.hits)
    .map((s) => toHit(s.t, 'keyword'));
  const close = semantic.filter((t) => hasAllTags(t, tags)).map((t) => toHit(t, 'semantic', t.score));

  const seen = new Set<string>();
  const merged: ThoughtSearchHit[] = [];
  for (const hit of [...full, ...close, ...partial]) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    merged.push(hit);
  }
  return merged.slice(0, topK);
}
