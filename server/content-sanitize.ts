import { getContainer } from './cosmos';

const APP_SETTINGS_CONTAINER = 'app-settings';
const CONTENT_FILTER_SETTINGS_ID = 'content-filter';

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPatterns(terms: string[]): RegExp[] {
  return terms.map(term => new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi'));
}

let cachedPatterns: RegExp[] | null = null;
let loadPromise: Promise<RegExp[]> | null = null;

async function loadPatterns(): Promise<RegExp[]> {
  const container = getContainer(APP_SETTINGS_CONTAINER);
  const { resource } = await container
    .item(CONTENT_FILTER_SETTINGS_ID, CONTENT_FILTER_SETTINGS_ID)
    .read<{ terms?: string[] }>();
  return buildPatterns(resource?.terms ?? []);
}

async function ensureLoaded(): Promise<RegExp[]> {
  if (cachedPatterns) return cachedPatterns;
  if (!loadPromise) loadPromise = loadPatterns();
  cachedPatterns = await loadPromise;
  return cachedPatterns;
}

/**
 * Forces the next sanitizeForModeration call to re-fetch the redact term list
 * from Cosmos. Called after the settings PUT endpoint updates the list, so
 * edits take effect without a server restart.
 */
export function refreshRedactionTerms(): void {
  cachedPatterns = null;
  loadPromise = null;
}

/**
 * Redacts configured slurs/terms before text is sent to Azure OpenAI. In-fiction
 * language (e.g. a slur spoken by an antagonist) can otherwise trip Azure's
 * content filter and block summarization/embedding of an entire chapter. Only
 * the outbound AI request is affected -- stored chapter content is untouched.
 */
export async function sanitizeForModeration(text: string): Promise<string> {
  const patterns = await ensureLoaded();
  return patterns.reduce((acc, pattern) => acc.replace(pattern, '[redacted]'), text);
}
