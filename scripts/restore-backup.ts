/**
 * Restores a Quill AI database backup zip into a Cosmos DB database.
 *
 *   npx ts-node scripts/restore-backup.ts <backup.zip> --database <name> [--containers a,b] [--dry-run]
 *
 * Uses the Cosmos endpoint/key from the app's normal config (_private/config.json
 * or environment). --database is required so a restore never lands on the live
 * database by accident; name the live one explicitly if that is what you mean.
 * Containers are created from their manifest definitions if missing. Restore is
 * insert-only: a document whose id already exists in the target is skipped and
 * never overwritten, so re-running is safe and live data is never replaced.
 * Ids are kept as-is because documents reference each other by id.
 *
 * Get the zip from the storage account's backups/ folder.
 */
import { CosmosClient } from '@azure/cosmos';
import config from '../server/config';
import { openBackupArchive } from '../server/services/backup-archive';

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const archive = await openBackupArchive(args.zip);
  const { manifest } = archive;

  console.log(`Backup of '${manifest.database}' taken ${manifest.createdAt}`);
  console.log(`Restoring into '${args.database}'${args.dryRun ? ' (dry run)' : ''}`);

  const client = new CosmosClient({ endpoint: config.cosmosEndpoint, key: config.cosmosKey });
  const database = args.dryRun
    ? null
    : (await client.databases.createIfNotExists({ id: args.database, throughput: 1000 })).database;

  for (const c of manifest.containers) {
    if (args.containers && !args.containers.includes(c.definition.id)) continue;
    if (!database) { console.log(`  ${c.definition.id}: ${c.documentCount} documents`); continue; }

    const { container } = await database.containers.createIfNotExists(c.definition as any);
    let created = 0;
    let skipped = 0;
    for await (const doc of archive.documents(c.file)) {
      try {
        await container.items.create(doc);
        created++;
      } catch (err: any) {
        if (err.code !== 409) throw err; // 409: already exists — never overwrite
        skipped++;
      }
      const n = created + skipped;
      if (n % 500 === 0) process.stdout.write(`\r  ${c.definition.id}: ${n}/${c.documentCount}`);
    }
    console.log(`\r  ${c.definition.id}: ${created} created, ${skipped} skipped (already existed) of ${c.documentCount}`);
  }
  archive.close();
}

main().catch(err => { console.error(err); process.exit(1); });
