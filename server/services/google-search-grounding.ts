/**
 * Google Search grounding via the Gemini API (Google AI Studio).
 *
 * Azure OpenAI answers from training knowledge alone, which is the weak spot in
 * any fact check. This service re-adjudicates a single claim against live web
 * results: Gemini runs its own searches through the built-in `google_search`
 * tool, then reports a verdict with the sources it actually consulted.
 *
 * Every call is best-effort. The Gemini free tier rate-limits aggressively, so
 * callers must treat `null` as "no grounding available for this claim" and fall
 * back to their own knowledge-based verdict rather than failing the request.
 */
import config from '../config';

/** Gemini model used when none is configured. Must support `google_search`. */
export const GEMINI_SEARCH_MODEL_DEFAULT = 'gemini-2.5-flash';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Per-claim ceiling. A grounded lookup runs several searches, so it is slow. */
const REQUEST_TIMEOUT_MS = 30000;

/** Sources are capped per claim — a citation list is a pointer, not a bibliography. */
const MAX_SOURCES = 4;

/** A web source Gemini consulted while grounding an answer. */
export interface GroundedSource {
  title: string;
  url: string;
}

/** The outcome of a grounded lookup for one claim. */
export interface GroundedVerdict {
  verdict: 'verified' | 'disputed' | 'unverifiable';
  confidence: number;
  explanation: string;
  /** How to fix the prose. Empty for a verified claim. */
  remedy: string;
  sources: GroundedSource[];
  /** The searches Gemini ran, for transparency in logs. */
  searchQueries: string[];
}

/** One claim to adjudicate. `quote` is the prose it came from, when available. */
export interface ClaimToGround {
  claim: string;
  quote?: string;
}

/** True when a Gemini API key is configured and grounded lookups can be tried. */
export function isSearchGroundingEnabled(): boolean {
  return !!config.googleAIStudio?.apiKey;
}

function searchModel(): string {
  return config.googleAIStudio?.searchModel || GEMINI_SEARCH_MODEL_DEFAULT;
}

const PROMPT_PREFIX =
  `You are a fact-checker with live web search. Search the web for the claim below, ` +
  `then judge it against what you find. Prefer authoritative, primary sources; if sources ` +
  `disagree, say so.\n\n`;

const PROMPT_SUFFIX =
  `\nReply with ONE raw JSON object and nothing else (no markdown, no code fences):\n` +
  `{"verdict":"verified"|"disputed"|"unverifiable","confidence":<integer 0-100>,` +
  `"explanation":<string>,"remedy":<string>}\n` +
  `- "verdict": "verified" if the sources you found support the claim, "disputed" if they ` +
  `contradict it, "unverifiable" if searching did not settle it.\n` +
  `- "confidence": how sure you are of this verdict given the sources you actually found. ` +
  `Lower it when sources are thin, indirect, or conflicting.\n` +
  `- "explanation": at most two sentences on what the sources say. For a dispute, state what ` +
  `is actually true. Be specific — name the figure, date or source that settles it.\n` +
  `- "remedy": for "disputed" or "unverifiable", one or two sentences telling the author of a ` +
  `novel what to change in the prose, naming the correct fact or value. Write it as an edit to ` +
  `make ("Replace X with Y", "Cut the specific figure and say ..."), not as a summary of the ` +
  `research. Use "" for "verified".\n` +
  `- The claim comes from a work of fiction. Judge only the real-world assertion, and never ` +
  `treat an invented name as a factual error.`;

/** Parses one JSON object out of a model reply, tolerating code fences. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const stripped = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Shape of the slice of the Gemini response this service reads. */
interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
    };
  }[];
  error?: { message?: string; status?: string };
}

/** Pulls the deduped source list out of the response's grounding metadata. */
function extractSources(response: GeminiResponse): GroundedSource[] {
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const sources: GroundedSource[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const url = chunk.web?.uri;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: chunk.web?.title?.trim() || url, url });
    if (sources.length >= MAX_SOURCES) break;
  }
  return sources;
}

/**
 * Adjudicates one claim against live Google Search results.
 * Returns null when grounding is unconfigured, rate-limited, times out, or comes
 * back unusable — the caller keeps its own verdict in that case.
 */
export async function groundClaim(claim: ClaimToGround): Promise<GroundedVerdict | null> {
  const apiKey = config.googleAIStudio?.apiKey;
  if (!apiKey) return null;

  const prompt =
    PROMPT_PREFIX +
    `Claim: ${claim.claim}\n` +
    (claim.quote ? `As written in the manuscript: "${claim.quote}"\n` : '') +
    PROMPT_SUFFIX;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${GEMINI_API_BASE}/${encodeURIComponent(searchModel())}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `google_search` is Gemini's built-in retrieval tool: it decides what to
        // search for and reports its sources back in groundingMetadata.
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
        }),
        signal: controller.signal,
      },
    );

    const json = (await response.json()) as GeminiResponse;
    if (!response.ok || json.error) {
      // 429 is routine on the free tier — log it plainly, don't treat as a bug.
      console.warn(
        `Search grounding skipped (${response.status} ${json.error?.status ?? ''}): ${json.error?.message ?? 'unknown error'}`,
      );
      return null;
    }

    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map(p => p.text ?? '').join('');
    const parsed = parseJsonObject(text);
    if (!parsed) return null;

    const verdict = parsed['verdict'];
    if (verdict !== 'verified' && verdict !== 'disputed' && verdict !== 'unverifiable') return null;

    const explanation = typeof parsed['explanation'] === 'string' ? parsed['explanation'].trim() : '';
    if (!explanation) return null;

    const rawConfidence = typeof parsed['confidence'] === 'number'
      ? parsed['confidence']
      : Number(parsed['confidence']);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(100, Math.round(rawConfidence)))
      : 50;

    const rawRemedy = typeof parsed['remedy'] === 'string' ? parsed['remedy'].trim() : '';

    return {
      verdict,
      confidence,
      explanation,
      remedy: verdict === 'verified' ? '' : rawRemedy,
      sources: extractSources(json),
      searchQueries: candidate?.groundingMetadata?.webSearchQueries ?? [],
    };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    console.warn(`Search grounding ${aborted ? 'timed out' : 'failed'} for a claim:`, aborted ? '' : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface GroundClaimsOptions {
  /** Maximum lookups in flight at once. */
  concurrency?: number;
  /** Called as each claim resolves, so callers can report progress live. */
  onResult?: (index: number, verdict: GroundedVerdict | null) => void;
  /** Polled before each lookup starts; return true to stop taking new claims.
   * Lets a caller abandon the run when the user cancels, instead of paying for
   * searches nobody will read. */
  isCancelled?: () => boolean;
}

/**
 * Grounds many claims, running at most `concurrency` lookups at a time so a long
 * chapter doesn't fire dozens of simultaneous requests at the rate limiter.
 * The returned array is index-aligned with `claims`; entries are null where
 * grounding didn't come through or the run was cancelled first.
 */
export async function groundClaims<T extends ClaimToGround>(
  claims: T[],
  options: GroundClaimsOptions = {},
): Promise<(GroundedVerdict | null)[]> {
  const { concurrency = 4, onResult, isCancelled } = options;
  const results: (GroundedVerdict | null)[] = new Array(claims.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < claims.length) {
      if (isCancelled?.()) return;
      const index = next++;
      const verdict = await groundClaim(claims[index]);
      results[index] = verdict;
      onResult?.(index, verdict);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, claims.length)) }, worker),
  );
  return results;
}
