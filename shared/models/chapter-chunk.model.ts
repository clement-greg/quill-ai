/**
 * A single chunk of a chapter's content together with its embedding vector.
 * Chunks live in the dedicated `chapter-chunks` Cosmos container (partitioned by
 * chapterId) and link back to their source chapter, so that semantic search can
 * retrieve relevant passages without loading whole chapters.
 */
export interface ChapterChunk {
    id: string;            // `${chapterId}:${chunkIndex}`
    chapterId: string;     // partition key — links back to the source chapter
    bookId: string;        // denormalized for book-scoped search
    seriesId?: string;     // denormalized for series-scoped search
    owner: string;         // denormalized for owner filtering
    chunkIndex: number;    // order within the chapter
    content: string;       // plain text of this chunk
    contentVector?: number[];
    createdAt: string;
    modifiedAt: string;
}
