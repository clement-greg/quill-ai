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

/** A paragraph that Azure's content filter rejected during (re)indexing, so it
 * was left out of the searchable chunk index. Surfaced to the author so they
 * know that passage won't be found by Ask Quill's chapter search. */
export interface ContentFilterWarning {
    /** Index of the chunked passage the paragraph was pulled from. */
    passageIndex: number;
    /** Preview of the omitted paragraph's text (truncated for display). */
    preview: string;
}
