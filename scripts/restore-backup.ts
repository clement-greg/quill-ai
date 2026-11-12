/**
 * Restores a Quill AI database backup zip into a Cosmos DB database.
 *
 *   npx ts-node scripts/restore-backup.ts <backup.zip> --database <name> [--containers a,b] [--dry-run]
 *
 * Uses the Cosmos endpoint/key from the app's normal config (_private/config.json
 * or environment). --database is required so a restore never lands on the live
 * database by accident; name the live one explicitly if that is what you mean.
 * Containers are created from their manifest definitions if missing, and every
 * document is upserted, so re-running is safe. Documents already in the target
 * that aren't in the backup are left alone.
 *
 * Get the zip from the storage account's backups/ folder.
 */
import readline from 'readline';
import yauzl from 'yauzl';
import { CosmosClient } from '@azure/cosmos';
import config from '../server/config';

interface ManifestContainer {
  file: string;
  documentCount: number;
  definition: { id: string; [key: string]: unknown };
}

function parseArgs(argv: string[]) {
  const args = { zip: '', database: '', containers: null as string[] | null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--database') args.database = argv[++i];
    else if (a === '--containers') args.containers = argv[++i].split(',').map(s => s.trim());
    else if (a === '--dry-run') args.dryRun = true;
    else if (!args.zip) args.zip = a;
  }
  if (!args.zip || !args.database) {
    console.error('Usage: npx ts-node scripts/restore-backup.ts <backup.zip> --database <name> [--containers a,b] [--dry-run]');
    process.exit(1);
  }
  return args;
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => (err || !zip ? reject(err) : resolve(zip))));
}

async function entriesOf(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
  const entries = new Map<string, yauzl.Entry>();
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (e: yauzl.Entry) => { entries.set(e.fileName, e); zip.readEntry(); });
    zip.on('end', resolve);
    zip.on('error', reject);
    zip.readEntry();
  });
  return entries;
}

function streamOf(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (err, s) => (err || !s ? reject(err) : resolve(s))));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const zip = await openZip(args.zip);
  const entries = await entriesOf(zip);

  const manifestEntry = entries.get('manifest.json');
  if (!manifestEntry) throw new Error('manifest.json not found — not a Quill AI backup?');
  let manifestText = '';
  for await (const chunk of await streamOf(zip, manifestEntry)) manifestText += chunk;
  const manifest = JSON.parse(manifestText) as { createdAt: string; database: string; containers: ManifestContainer[] };

  console.log(`Backup of '${manifest.database}' taken ${manifest.createdAt}`);
  console.log(`Restoring into '${args.database}'${args.dryRun ? ' (dry run)' : ''}`);

  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, key: config.cosmosKey });
  const database = args.dryRun
    ? null
    : (await client.databases.createIfNotExists({ id: args.database, throughput: 1000 })).database;

  for (const c of manifest.containers) {
    if (args.containers && !args.containers.includes(c.definition.id)) continue;
    const entry = entries.get(c.file);
    if (!entry) { console.warn(`  ${c.definition.id}: ${c.file} missing from zip, skipped`); continue; }
    if (!database) { console.log(`  ${c.definition.id}: ${c.documentCount} documents`); continue; }

    const { container } = await database.containers.createIfNotExists(c.definition as any);
    let n = 0;
    const lines = readline.createInterface({ input: await streamOf(zip, entry), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      await container.items.upsert(JSON.parse(line));
      if (++n % 500 === 0) process.stdout.write(`\r  ${c.definition.id}: ${n}/${c.documentCount}`);
    }
    console.log(`\r  ${c.definition.id}: ${n}/${c.documentCount} documents restored`);
  }
  zip.close();
}

main().catch(err => { console.error(err); process.exit(1); });
