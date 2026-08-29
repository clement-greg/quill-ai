/**
 * Types for the chapter "Fact Check" feature: a pass that pulls every
 * real-world checkable claim out of a chapter's prose and reports whether it
 * holds up, with a confidence level on every finding.
 *
 * A run's findings are ephemeral while they stream, but a finished run can be
 * kept: see `FactCheckReport` at the foot of this file, which saves a run
 * against its chapter along with the author's check-off state per finding.
 *
 * A check runs in two stages: the chapter is read once to pull out its checkable
 * claims, then the claims the model was NOT confident about are re-adjudicated
 * against live Google Search results. Grounding is best-effort (rate limits,
 * timeouts), so a finding carries `grounded` to say whether the web actually
 * backed it, and `confidence` to say how much weight the author should put on it
 * either way.
 */

import { AuditedRecord } from './audited-record';

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

/**
 * One SSE payload from POST /api/fact-check. A run emits `stage: 'extracting'`
 * while the chapter is read, then `stage: 'checking'` with the claim count, then
 * one `finding` per claim as its lookup settles — so the client can show real
 * progress instead of an indefinite wait.
 */
export type FactCheckStreamEvent =
  | {
      stage: 'extracting';
      /** How many parts the chapter was split into for reading. A chapter short
       * enough to read in one pass reports 1. */
      segmentsTotal: number;
      /** How many of those parts have been read. Re-emitted as each lands, so a
       * long chapter shows progress through the reading stage too. */
      segmentsDone: number;
    }
  | {
      stage: 'checking';
      /** How many claims will be reported, so progress can be determinate. */
      total: number;
      /** How many of those claims are going out for a web double-check — the
       * only slow part of the run. The rest are already settled. */
      webCheckCount: number;
      /** True when the chapter was longer than the check's input limit and only
       * the opening portion was examined. */
      truncated: boolean;
      /** True when web search grounding is configured on the server, so the
       * report can distinguish "not searched" from "search found nothing". */
      searchAvailable: boolean;
    }
  | { finding: FactCheckFinding }
  | { error: string };

// ── Saved reports ──────────────────────────────────────────────────────────
//
// A run is ephemeral while it streams, but the author can keep the result: each
// finished run is saved as its own dated report against the chapter, so the
// findings can be revisited later and worked through one at a time. Reports are
// never rewritten by a later run — a re-check adds a new report alongside the
// old ones, the same way chapter versions accumulate.

/** One finding inside a saved report, plus the author's triage state. */
export interface SavedFactCheckFinding extends FactCheckFinding {
  /** True once the author has dealt with this finding — corrected the prose, or
   * decided they are content to leave it factually wrong. */
  resolved?: boolean;
  /** When it was checked off, for display next to the tick. */
  resolvedAt?: string;
}

/**
 * One saved fact-check run. Carries the run's own caveats alongside its
 * findings, because a report read weeks later has to explain itself: a
 * truncated or stopped run covered only part of the chapter, and a run made
 * without search grounding rests on model knowledge alone.
 */
export interface FactCheckReport extends AuditedRecord {
  id: string;
  /** Discriminator for the shared `chapter-versions` container, which holds
   * both version snapshots and these reports. Always set on a saved report. */
  docType: 'fact-check-report';
  /** Partition key — all of a chapter's reports live together, alongside that
   * chapter's version snapshots. */
  chapterId: string;
  /** When the run finished, ISO 8601. */
  runAt: string;
  /** The chapter's title at run time. Kept on the report so an old run still
   * names the chapter it checked even after a rename. */
  chapterTitle?: string;
  findings: SavedFactCheckFinding[];
  /** How many claims the run set out to report. Higher than `findings.length`
   * when the run was stopped part-way. */
  total: number;
  /** True when the chapter was too long and only its opening was checked. */
  truncated: boolean;
  /** True when the author stopped the run before it finished. */
  stopped: boolean;
  /** True when web-search grounding was configured for this run. */
  searchAvailable: boolean;
}

/** Body for PATCH /api/fact-check-reports/:id/findings/:findingId. */
export interface FactCheckResolveRequest {
  /** Partition key for the report being updated. */
  chapterId: string;
  resolved: boolean;
}
