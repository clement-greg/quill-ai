import { Request } from 'express';
import { SqlParameter } from '@azure/cosmos';
import { getContainer } from './cosmos';
import { generateEmbedding } from './embeddings';
import { withOwnerFilter } from '../middleware/owner-guard';
import { TimelineEvent } from '../../shared/models/timeline-event.model';
import { TimelineEventChunk } from '../../shared/models/timeline-event-chunk.model';

const chunksContainer = getContainer('timeline-event-chunks');

/**
 * The text embedded (and shown to the model) for a timeline event. The entity
 * name is included up front so a query like "Jim's fate" matches the event even
 * when the event title alone ("a fatal fall") doesn't name the character.
 */
function buildEventContent(entityName: string, event: TimelineEvent): string {
  const parts = [`${entityName}: ${event.name}`];
  if (event.timeframe) parts.push(`(${event.timeframe})`);
  if (event.description) parts.push(`— ${event.description}`);
  if (event.location) parts.push(`[Location: ${event.location}]`);
  return parts.join(' ');
}

/**
 * Embeds a single timeline event and upserts its chunk (id === event id, so this
 * is idempotent — create and update both call it). Embedding/storage failures are
 * logged but never thrown, so saving a timeline event is never blocked by the AI
 * service being unavailable. `entityName` is denormalized into the chunk so search
 * hits can be labeled without re-reading the entity.
 */
export async function indexTimelineEvent(event: TimelineEvent, entityName: string): Promise<void> {
  try {
    const content = buildEventContent(entityName, event);
    const contentVector = await generateEmbedding(content);
    const now = new Date().toISOString();
    const doc: TimelineEventChunk = {
      id: event.id,
      eventId: event.id,
      entityId: event.entityId,
      entityName,
      seriesId: event.seriesId,
      chapterId: event.chapterId,
      owner: event.owner ?? '',
      content,
      contentVector,
      createdAt: now,
      modifiedAt: now,
    };
    await chunksContainer.items.upsert<TimelineEventChunk>(doc);
  } catch (err) {
    console.error(`Failed to index timeline event ${event.id}:`, err);
  }
}

/** Removes the chunk for a single timeline event. Best-effort. */
export async function deleteTimelineEventChunk(eventId: string, entityId: string): Promise<void> {
  try {
    await chunksContainer.item(eventId, entityId).delete();
  } catch (err) {
    // A 404 just means there was nothing indexed (e.g. embedding had failed) — ignore.
    if ((err as { code?: number })?.code !== 404) {
      console.error(`Failed to delete timeline event chunk ${eventId}:`, err);
    }
  }
}

/** Removes every chunk belonging to an entity (single partition). Best-effort. */
export async function deleteTimelineEventChunksForEntity(entityId: string): Promise<void> {
  try {
    const { resources } = await chunksContainer.items
      .query<{ id: string }>(
        {
          query: 'SELECT c.id FROM c WHERE c.entityId = @entityId',
          parameters: [{ name: '@entityId', value: entityId }],
        },
        { partitionKey: entityId },
      )
      .fetchAll();
    await Promise.all(resources.map(r => chunksContainer.item(r.id, entityId).delete()));
  } catch (err) {
    console.error(`Failed to delete timeline event chunks for entity ${entityId}:`, err);
  }
}

export interface TimelineEventSearchResult {
  eventId: string;
  entityId: string;
  entityName: string;
  chapterId?: string;
  content: string;
  score: number;
}

/**
 * Semantic search over timeline-event chunks using cosine VectorDistance. Scopes
 * to the requesting user and optionally to a single series. Returns the top-K most
 * relevant events ordered by similarity, or an empty array on any failure so
 * callers can fall back gracefully.
 */
export async function searchTimelineEvents(
  queryText: string,
  opts: { seriesId?: string; entityId?: string; topK?: number },
  source: Request | string,
): Promise<TimelineEventSearchResult[]> {
  try {
    const topK = Math.max(1, Math.min(50, Math.floor(opts.topK ?? 5)));
    const vector = await generateEmbedding(queryText);

    const filters: string[] = [];
    const parameters: SqlParameter[] = [{ name: '@vec', value: vector }];
    if (opts.seriesId) {
      filters.push('c.seriesId = @seriesId');
      parameters.push({ name: '@seriesId', value: opts.seriesId });
    }
    if (opts.entityId) {
      filters.push('c.entityId = @entityId');
      parameters.push({ name: '@entityId', value: opts.entityId });
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')} ` : '';
    // `true` forces brute-force (full-scan) distance — required as this container
    // has no dedicated vector index (see cosmos.ts). SELECT and ORDER BY must match.
    const distance = 'VectorDistance(c.contentVector, @vec, true)';
    const query = withOwnerFilter(source, {
      query:
        `SELECT TOP ${topK} c.eventId, c.entityId, c.entityName, c.chapterId, c.content, ${distance} AS score ` +
        `FROM c ${where}ORDER BY ${distance}`,
      parameters,
    });

    const { resources } = await chunksContainer.items.query<TimelineEventSearchResult>(query).fetchAll();
    return resources;
  } catch (err) {
    console.error('Timeline event search failed:', err);
    return [];
  }
}
