/**
 * The embedding of a single timeline event (one of the LLM-built "key events" on
 * an entity), stored in the dedicated `timeline-event-chunks` Cosmos container
 * (partitioned by entityId). Lets semantic search surface structured story-bible
 * facts — e.g. "Jim is killed" — that the prose only alludes to and that plain
 * chapter-chunk search therefore misses. One chunk per timeline event; the chunk
 * id is the event id so re-indexing is an idempotent upsert.
 */
export interface TimelineEventChunk {
    id: string;            // = the source timeline event id
    eventId: string;       // the source timeline event
    entityId: string;      // partition key — the entity the event belongs to
    entityName: string;    // denormalized so search hits can be labeled without a join
    seriesId?: string;     // denormalized for series-scoped search
    chapterId?: string;    // source chapter (chapter-extracted events) — enables citation
    owner: string;         // denormalized for owner filtering
    content: string;       // embedded text (entity name + event name + timeframe + description + location)
    contentVector?: number[];
    createdAt: string;
    modifiedAt: string;
}
