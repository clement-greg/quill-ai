/** Reading a backup zip (see database-backup.ts for the layout). */
import readline from 'readline';
import yauzl from 'yauzl';

export interface BackupManifestContainer {
  file: string;
  documentCount: number;
  definition: { id: string; [key: string]: unknown };
}

export interface BackupManifest {
  formatVersion: number;
  database: string;
  createdAt: string;
  containers: BackupManifestContainer[];
}

export interface BackupArchive {
  manifest: BackupManifest;
  /** The documents of one container file, parsed, in order. */
  documents(file: string): AsyncGenerator<Record<string, unknown>>;
  close(): void;
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => (err || !zip ? reject(err) : resolve(zip))));
}

function readEntries(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
  const entries = new Map<string, yauzl.Entry>();
  return new Promise((resolve, reject) => {
    zip.on('entry', (e: yauzl.Entry) => { entries.set(e.fileName, e); zip.readEntry(); });
    zip.on('end', () => resolve(entries));
    zip.on('error', reject);
    zip.readEntry();
  });
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (err, s) => (err || !s ? reject(err) : resolve(s))));
}

export async function openBackupArchive(path: string): Promise<BackupArchive> {
  const zip = await openZip(path);
  try {
    const entries = await readEntries(zip);
    const manifestEntry = entries.get('manifest.json');
    if (!manifestEntry) throw new Error('manifest.json not found — not a Quill AI backup?');
    let text = '';
    for await (const chunk of await entryStream(zip, manifestEntry)) text += chunk;
    const manifest = JSON.parse(text) as BackupManifest;

    return {
      manifest,
      async *documents(file: string) {
        const entry = entries.get(file);
        if (!entry) throw new Error(`${file} missing from backup`);
        const lines = readline.createInterface({ input: await entryStream(zip, entry), crlfDelay: Infinity });
        for await (const line of lines) {
          if (line.trim()) yield JSON.parse(line);
        }
      },
      close: () => zip.close(),
    };
  } catch (err) {
    zip.close();
    throw err;
  }
}
