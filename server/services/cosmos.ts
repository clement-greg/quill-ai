import { CosmosClient, Database, Container } from '@azure/cosmos';
import config from '../config';

const client = new CosmosClient({
  endpoint: config.cosmosEndpoint,
  key: config.cosmosKey,
});

const database: Database = client.database(config.cosmosDatabase);

const standardContainerDefs = [
  { id: 'user-settings', partitionKey: { paths: ['/id'] } },
  // Global (not per-user) app-wide settings, one document per setting keyed by a
  // fixed well-known id, e.g. { id: 'content-filter', terms: string[] }.
  { id: 'app-settings', partitionKey: { paths: ['/id'] } },
  // Append-only log of chapter visits, partitioned per user. One insert per
  // visit — never updated or deleted. The "Continue writing" list is derived by
  // querying this log newest-first and taking the most recent distinct chapters.
  { id: 'chapter-visits', partitionKey: { paths: ['/userSub'] } },
  { id: 'series', partitionKey: { paths: ['/id'] } },
  { id: 'books', partitionKey: { paths: ['/id'] } },
  { id: 'book-notes', partitionKey: { paths: ['/id'] } },
  { id: 'entities', partitionKey: { paths: ['/id'] } },
  { id: 'chat-history', partitionKey: { paths: ['/id'] } },
  { id: 'chat-sessions', partitionKey: { paths: ['/id'] } },
  { id: 'chat-folders', partitionKey: { paths: ['/id'] } },
  { id: 'chat-folder-files', partitionKey: { paths: ['/id'] } },
  { id: 'folder-notes', partitionKey: { paths: ['/id'] } },
  // Holds two kinds of per-chapter document, told apart by `docType`: version
  // snapshots ('version', or absent on records written before the field
  // existed) and saved fact-check runs ('fact-check-report'). They share a
  // container because the database is at its 25-container ceiling and both are
  // partitioned by exactly the same key — every query here must filter on
  // docType so one kind never leaks into the other's results.
  { id: 'chapter-versions', partitionKey: { paths: ['/chapterId'] } },
  { id: 'entity-relationships', partitionKey: { paths: ['/id'] } },
  { id: 'diagram-layouts', partitionKey: { paths: ['/id'] } },
  { id: 'entity-quotes', partitionKey: { paths: ['/entityId'] } },
  { id: 'timeline-events', partitionKey: { paths: ['/entityId'] } },
  { id: 'mention-counts', partitionKey: { paths: ['/id'] } },
  { id: 'maps', partitionKey: { paths: ['/id'] } },
  { id: 'map-assets', partitionKey: { paths: ['/id'] } },
  // Generation jobs queued on the external receiver, keyed by the ComfyUI prompt
  // id. The collector reads its work list from here rather than from memory, so
  // a restart mid-generation resumes instead of losing the job.
  { id: 'generation-jobs', partitionKey: { paths: ['/id'] } },
];

// text-embedding-3-small produces 1536-dimensional vectors.
// A vectorEmbeddingPolicy is required to store vectors in Cosmos DB.
// A vectorIndex is NOT used here — the account's 1000 RU/s shared limit would
// be exceeded by dedicated container throughput. VectorDistance() queries still
// work on shared throughput via full scan, which is fine for this app's scale.
//
// NOTE: The chapters container historically stored a single `/contentVector` for
// the whole chapter. That field is no longer written or read — embeddings now live
// in the dedicated `chapter-chunks` container below (one vector per content chunk).
// The vector policy is kept here only because Cosmos cannot remove it from an
// existing container; the field is harmless dead data on legacy chapters.
const chaptersContainerDef = {
  id: 'chapters',
  partitionKey: { paths: ['/id'] },
  vectorEmbeddingPolicy: {
    vectorEmbeddings: [
      {
        path: '/contentVector',
        dataType: 'float32',
        distanceFunction: 'cosine',
        dimensions: 1536,
      },
    ],
  },
  indexingPolicy: {
    automatic: true,
    indexingMode: 'consistent',
    includedPaths: [{ path: '/*' }],
    excludedPaths: [{ path: '/contentVector/*' }],
  },
};

// Stores per-chunk embeddings for chapters, partitioned by chapterId so that all
// chunks of a chapter live in one partition (cheap to list, replace, and delete
// together). Mirrors the chapters vector policy: cosine distance over 1536-dim
// float32 vectors, with the vector path excluded from the standard index.
const chapterChunksContainerDef = {
  id: 'chapter-chunks',
  partitionKey: { paths: ['/chapterId'] },
  vectorEmbeddingPolicy: {
    vectorEmbeddings: [
      {
        path: '/contentVector',
        dataType: 'float32',
        distanceFunction: 'cosine',
        dimensions: 1536,
      },
    ],
  },
  indexingPolicy: {
    automatic: true,
    indexingMode: 'consistent',
    includedPaths: [{ path: '/*' }],
    excludedPaths: [{ path: '/contentVector/*' }],
  },
};

// Stores one embedding per timeline event (the LLM-built "key events" on an
// entity), partitioned by entityId so all of an entity's event chunks live in
// one partition (cheap to list and delete together). Mirrors the chapter-chunks
// vector policy: cosine distance over 1536-dim float32 vectors, vector path
// excluded from the standard index.
const timelineEventChunksContainerDef = {
  id: 'timeline-event-chunks',
  partitionKey: { paths: ['/entityId'] },
  vectorEmbeddingPolicy: {
    vectorEmbeddings: [
      {
        path: '/contentVector',
        dataType: 'float32',
        distanceFunction: 'cosine',
        dimensions: 1536,
      },
    ],
  },
  indexingPolicy: {
    automatic: true,
    indexingMode: 'consistent',
    includedPaths: [{ path: '/*' }],
    excludedPaths: [{ path: '/contentVector/*' }],
  },
};

// Stores thoughts with a single vector embedding over (title + content).
// Cosine distance over 1536-dim float32 vectors; vector path excluded from
// the standard index (same pattern as chapters and chapter-chunks).
const thoughtsContainerDef = {
  id: 'thought-items',
  partitionKey: { paths: ['/id'] },
  vectorEmbeddingPolicy: {
    vectorEmbeddings: [
      {
        path: '/contentVector',
        dataType: 'float32',
        distanceFunction: 'cosine',
        dimensions: 1536,
      },
    ],
  },
  indexingPolicy: {
    automatic: true,
    indexingMode: 'consistent',
    includedPaths: [{ path: '/*' }],
    excludedPaths: [{ path: '/contentVector/*' }],
  },
};

export function getContainer(containerName: string): Container {
  return database.container(containerName);
}

export async function initDatabase(): Promise<void> {
  await client.databases.createIfNotExists({
    id: config.cosmosDatabase,
    throughput: 1000,
  });

  // Create standard containers. Each is attempted on its own: one container
  // that can't be created must not stop the rest from being, which is what a
  // single try around the whole loop used to do.
  for (const def of standardContainerDefs) {
    try {
      await database.containers.createIfNotExists(def);
    } catch (err: any) {
      // 1028: the shared offer already covers this container.
      if (err.code === 400 && err.substatus === 1028) continue;
      // 1019: the shared-throughput database is at its 25-container ceiling.
      // The app still runs — every existing feature works — but whatever reads
      // this container will fail until a slot is freed or it is given its own
      // throughput, so say exactly that rather than crashing on boot.
      if (err.code === 400 && err.substatus === 1019) {
        console.error(
          `Cosmos container '${def.id}' was not created: the database is at its ` +
          '25-container limit. Features backed by it will not work until a container ' +
          'is removed or this one is created with dedicated throughput.',
        );
        continue;
      }
      throw err;
    }
  }

  // Create containers with vector embedding policies if they don't exist.
  // Note: vector embedding policies cannot be changed on existing containers.
  await database.containers.createIfNotExists(chaptersContainerDef as any);
  await database.containers.createIfNotExists(chapterChunksContainerDef as any);
  await database.containers.createIfNotExists(timelineEventChunksContainerDef as any);
  await database.containers.createIfNotExists(thoughtsContainerDef as any);
}
