import { CosmosClient, Database, Container } from '@azure/cosmos';
import config from './config';

const client = new CosmosClient({
  endpoint: config.cosmosEndpoint,
  key: config.cosmosKey,
});

const database: Database = client.database(config.cosmosDatabase);

const standardContainerDefs = [
  { id: 'user-settings', partitionKey: { paths: ['/id'] } },
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
  { id: 'chapter-versions', partitionKey: { paths: ['/chapterId'] } },
  { id: 'entity-relationships', partitionKey: { paths: ['/id'] } },
  { id: 'diagram-layouts', partitionKey: { paths: ['/id'] } },
  { id: 'entity-quotes', partitionKey: { paths: ['/entityId'] } },
  { id: 'timeline-events', partitionKey: { paths: ['/entityId'] } },
  { id: 'mention-counts', partitionKey: { paths: ['/id'] } },
  { id: 'maps', partitionKey: { paths: ['/id'] } },
  { id: 'map-assets', partitionKey: { paths: ['/id'] } },
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

export function getContainer(containerName: string): Container {
  return database.container(containerName);
}

export async function initDatabase(): Promise<void> {
  await client.databases.createIfNotExists({
    id: config.cosmosDatabase,
    throughput: 1000,
  });

  // Create standard containers
  try {
    for (const def of standardContainerDefs) {
      await database.containers.createIfNotExists(def);
    }
  } catch (err: any) {
    if (err.code !== 400 || err.substatus !== 1028) throw err;
  }

  // Create containers with vector embedding policies if they don't exist.
  // Note: vector embedding policies cannot be changed on existing containers.
  await database.containers.createIfNotExists(chaptersContainerDef as any);
  await database.containers.createIfNotExists(chapterChunksContainerDef as any);
}
