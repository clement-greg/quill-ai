/**
 * Types for the chapter "Fact Check" feature: a pass that pulls every
 * real-world checkable claim out of a chapter's prose and reports whether it
 * holds up, with a confidence level on every finding.
 *
 * Findings are EPHEMERAL — generated fresh per run and never persisted.
 *
 * A check runs in two stages: the chapter is read once to pull out its checkable
 * claims, then each claim is re-adjudicated against live Google Search results.
 * Grounding is best-effort (rate limits, timeouts), so a finding carries
 * `grounded` to say whether the web actually backed it, and `confidence` to say
 * how much weight the author should put on it either way.
 */

/** How a checkable claim held up against real-world knowledge. */
export type FactCheckVerdict =
  /** Matches well-established real-world fact. */
  | 'verified'
  /** Contradicts well-established real-world fact. */
  | 'disputed'
  /** Checkable in principle, but the check couldn't settle it. */
  | 'unverifiable';

/** A web page consulted while checking a claim. */
export interface FactCheckSource {
  /** Page or site title, falling back to the URL. */
  title: string;
  url: string;
}

/** The domain of knowledge a claim belongs to — used to group and label findings. */
export type FactCheckCategory =
  | 'history'
  | 'geography'
  | 'science'
  | 'nature'
  | 'technology'
  | 'medicine'
  | 'culture'
  | 'language'
  | 'law'
  | 'math'
  | 'other';

/** One checkable claim found in the chapter, plus its verdict. */
export interface FactCheckFinding {
  /** Server-assigned unique id. */
  id: string;
  /** The claim restated as a plain, self-contained statement. */
  claim: string;
  /** Verbatim excerpt of the prose the claim came from. Omitted when the model
   * couldn't quote the chapter exactly (the claim still stands on its own). */
  quote?: string;
  category: FactCheckCategory;
  verdict: FactCheckVerdict;
  /** How sure the check is of this verdict, 0–100. */
  confidence: number;
  /** Why the verdict was reached — the correct fact, for a dispute. */
  explanation: string;
  /** Concrete instruction for fixing the prose. Present for disputed and
   * unverifiable findings; absent for verified ones, which need no action. */
  remedy?: string;
  /** True when this verdict was reached from live web search results rather than
   * model knowledge alone. */
  grounded: boolean;
  /** Web pages behind a grounded verdict. Absent when `grounded` is false. */
  sources?: FactCheckSource[];
}

/** Request body for POST /api/fact-check. */
export interface FactCheckRequest {
  /** Plain-text chapter prose. */
  text: string;
  /** Names of story entities, so invented people/places aren't fact-checked. */
  knownEntityNames?: string[];
}

/** Response body for POST /api/fact-check. */
export interface FactCheckResult {
  /** Findings ordered most-actionable first: disputed, unverifiable, verified. */
  findings: FactCheckFinding[];
  /** True when the chapter was longer than the check's input limit and only the
   * opening portion was examined. */
  truncated: boolean;
  /** True when web search grounding is configured on the server, so the report
   * can distinguish "not searched" from "search found nothing". */
  searchAvailable: boolean;
  /** How many findings were settled with live web sources. */
  groundedCount: number;
}
