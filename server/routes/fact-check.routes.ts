import { Router, Request, Response } from 'express';
import { AzureOpenAI } from 'openai';
import { randomUUID } from 'crypto';
import config from '../config';
import {
  FactCheckCategory,
  FactCheckFinding,
  FactCheckStreamEvent,
  FactCheckVerdict,
} from '../../shared/models/fact-check.model';
import { GroundedVerdict, groundClaims, isSearchGroundingEnabled } from '../services/google-search-grounding';

const router = Router();

const client = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: config.foundry.apiVersion,
});

/**
 * Most a single extraction pass is asked to read. A chapter longer than this is
 * split into segments and each is read on its own, so a long chapter is checked
 * end to end rather than from the start until the budget runs out.
 */
const MAX_SEGMENT_CHARS = 20000;

/** Segments read per run. Twelve covers ~240k characters — far longer than any
 * real chapter — so `truncated` is now a genuine outlier rather than routine. */
const MAX_SEGMENTS = 12;

/** Extraction passes in flight at once. Kept low so a long chapter doesn't
 * burst the Azure deployment's rate limit. */
const EXTRACT_CONCURRENCY = 3;

/** Web-grounded lookups allowed per segment, and the ceiling across the whole
 * run. Each lookup costs a round of searches, so the budget grows with the
 * chapter instead of leaving a long chapter's later claims unchecked. Claims are
 * grounded in report order, so disputes are always covered first. */
const GROUNDED_CLAIMS_PER_SEGMENT = 20;
const MAX_GROUNDED_CLAIMS = 60;

/**
 * Splits plain chapter prose into extraction-sized segments, each a VERBATIM
 * substring of the input — quotes are validated against the full chapter, so a
 * segment that reflowed its whitespace would cost every finding its quote.
 *
 * Line breaks are preferred as cut points so a segment starts on a paragraph;
 * a single paragraph longer than the budget is split on spaces as a last resort.
 */
export function segmentText(text: string, maxChars = MAX_SEGMENT_CHARS): string[] {
  if (text.length <= maxChars) return text.trim() ? [text] : [];

  const segments: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= maxChars) {
      segments.push(text.slice(start));
      break;
    }
    const slice = text.slice(start, start + maxChars);
    // Cut after the last paragraph break, then the last space. A break is only
    // worth taking if it leaves a segment worth reading; otherwise cut at the
    // hard limit, which costs at most one claim spanning the seam.
    let cut = slice.lastIndexOf('\n') + 1;
    if (cut < maxChars / 2) cut = slice.lastIndexOf(' ') + 1;
    if (cut < maxChars / 2) cut = maxChars;
    segments.push(text.slice(start, start + cut));
    start += cut;
  }
  return segments.filter(s => s.trim().length > 0);
}

/**
 * A first-pass verdict at or above this confidence is taken as settled and is
 * not sent out for a web double-check. Matches the threshold the report labels
 * "High confidence", so what the author sees as high confidence is exactly what
 * the run trusted without searching.
 */
const CONFIDENT_ENOUGH = 80;

/**
 * Whether a first-pass finding is worth the cost of a live web lookup.
 *
 * Low confidence is the signal: the model is telling us it isn't sure, which is
 * what search is for. `unverifiable` always qualifies regardless of its score —
 * that verdict means "my knowledge can't settle this", so a model can be highly
 * confident it doesn't know, and those are the best search candidates of all.
 */
function needsWebCheck(finding: FactCheckFinding): boolean {
  return finding.verdict === 'unverifiable' || finding.confidence < CONFIDENT_ENOUGH;
}

const VALID_VERDICTS: ReadonlySet<string> = new Set<FactCheckVerdict>([
  'verified', 'disputed', 'unverifiable',
]);
const VALID_CATEGORIES: ReadonlySet<string> = new Set<FactCheckCategory>([
  'history', 'geography', 'science', 'nature', 'technology', 'medicine',
  'culture', 'language', 'law', 'math', 'other',
]);

/** Verdicts in report order — the author's to-do list comes first. */
const VERDICT_RANK: Record<FactCheckVerdict, number> = {
  disputed: 0,
  unverifiable: 1,
  verified: 2,
};

const SYSTEM_PROMPT = `You are a research fact-checker for a fiction author. You are given the prose of one chapter of a novel. Your job is to find every statement in it that makes a claim about the REAL world, then judge whether that claim is accurate.

WHAT TO CHECK — any assertion that could be true or false independently of the story, for example:
- historical events, people, dates, and their order
- geography: places, distances, travel times, terrain, climate, time zones
- science and nature: physics, chemistry, astronomy, animal behavior, plants and seasons, human anatomy
- medicine: injuries, illnesses, drugs, treatments, recovery times, causes of death
- technology and mechanics: how weapons, vehicles, tools, machines, and materials actually behave
- law, institutions, and procedure (police, courts, military rank and protocol)
- language: etymology, translation, foreign phrases, quotations attributed to real sources
- math and arithmetic: sums, ages, dates, and quantities stated in the text
- culture: real books, films, songs, brands, products, and when they existed

WHAT TO IGNORE — never report these:
- invented people, places, creatures, organizations, magic, technology, or lore belonging to the story's world, including anything about a name in the Known story entities list
- claims that are only true or false inside the story (plot continuity, whether a character is lying, timeline consistency within the book) — someone else checks those
- opinions, metaphors, similes, hyperbole, and figurative language
- a character stating something false when the narration makes clear it is their mistaken belief or a lie

FOR EACH CLAIM, decide a verdict:
- "verified": it matches well-established real-world fact.
- "disputed": it contradicts well-established real-world fact.
- "unverifiable": it is a real-world claim, but general knowledge cannot settle it (too specific, too obscure, or genuinely contested by experts).

You have NO web access — judge only from your own knowledge, and let "confidence" carry your uncertainty. Never invent a citation.

OUTPUT — respond with a raw JSON object (no markdown, no code fences) of the form:
{"findings": [ ... ]}

Each finding has:
- "claim": the claim restated as one plain, self-contained sentence a reader can judge without the chapter in front of them.
- "quote": the exact verbatim substring of the chapter the claim comes from, copied character-for-character (original casing and punctuation). Keep it short — one sentence or less.
- "category": one of history, geography, science, nature, technology, medicine, culture, language, law, math, other.
- "verdict": "verified", "disputed", or "unverifiable".
- "confidence": an integer 0-100 — how sure you are of THIS VERDICT. Use 90+ only for facts you are certain of, 60-89 when confident but not certain, below 60 when genuinely unsure.
- "explanation": one or two sentences of reasoning. For a dispute, state what is actually true.
- "remedy": REQUIRED for "disputed" and "unverifiable" — a concrete, specific instruction the author can act on, naming the replacement fact or value where possible (e.g. "Change 'three hundred miles' to 'about ninety miles' — that is the real road distance", or "Verify against a 1912 railway timetable, or cut the specific departure time"). Omit this field entirely for "verified".

Report every distinct claim you find, verified ones included — the author wants the full picture. Do not report the same claim twice. If the chapter contains no real-world claims at all, return {"findings": []}.`;

/** Validates and normalizes one raw model object into a FactCheckFinding, or
 * returns null when it's malformed beyond use. */
function toFinding(raw: unknown, text: string): FactCheckFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const claim = typeof o['claim'] === 'string' ? o['claim'].trim() : '';
  const explanation = typeof o['explanation'] === 'string' ? o['explanation'].trim() : '';
  // Without a claim and a rationale there is nothing to show the author.
  if (!claim || !explanation) return null;

  const verdict = (typeof o['verdict'] === 'string' && VALID_VERDICTS.has(o['verdict']))
    ? (o['verdict'] as FactCheckVerdict)
    : null;
  if (!verdict) return null;

  const category = (typeof o['category'] === 'string' && VALID_CATEGORIES.has(o['category']))
    ? (o['category'] as FactCheckCategory)
    : 'other';

  // Clamp to 0-100; a missing or unparseable score is treated as middling.
  const rawConfidence = typeof o['confidence'] === 'number' ? o['confidence'] : Number(o['confidence']);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(100, Math.round(rawConfidence)))
    : 50;

  // Keep the quote only when it really anchors to the prose — a paraphrased
  // quote would send the author hunting for text that isn't there.
  const rawQuote = typeof o['quote'] === 'string' ? o['quote'].trim() : '';
  const quote = rawQuote && text.includes(rawQuote) ? rawQuote : '';

  const rawRemedy = typeof o['remedy'] === 'string' ? o['remedy'].trim() : '';
  // A verified claim needs no action, so any remedy it came with is noise.
  const remedy = verdict === 'verified' ? '' : rawRemedy;

  return {
    id: randomUUID(),
    claim,
    ...(quote ? { quote } : {}),
    category,
    verdict,
    confidence,
    explanation,
    ...(remedy ? { remedy } : {}),
    // Stage 2 upgrades this when live search backs the verdict.
    grounded: false,
  };
}

/** Drops repeats of the same claim, keeping the first (highest-ranked) one. */
function dedupe(findings: FactCheckFinding[]): FactCheckFinding[] {
  const seen = new Set<string>();
  return findings.filter(f => {
    const key = f.claim.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Folds a grounded verdict into the knowledge-based finding it re-checked. */
function withGroundedVerdict(finding: FactCheckFinding, grounded: GroundedVerdict): FactCheckFinding {
  return {
    ...finding,
    verdict: grounded.verdict,
    confidence: grounded.confidence,
    explanation: grounded.explanation,
    // A remedy from the first pass is stale once the web has spoken.
    ...(grounded.remedy ? { remedy: grounded.remedy } : { remedy: undefined }),
    grounded: true,
    ...(grounded.sources.length > 0 ? { sources: grounded.sources } : {}),
  };
}

/**
 * POST /api/fact-check
 * Fact-checks the real-world claims in a chapter's prose. Body:
 *   { text: string, knownEntityNames?: string[] }
 *
 * The chapter is read in segments (see `segmentText`) so that a long chapter is
 * checked end to end rather than from its opening until a character budget runs
 * out. Azure OpenAI extracts the claims in each segment and judges them from its
 * own knowledge; the claims across all segments are then pooled, de-duplicated,
 * and only the ones it wasn't confident about are double-checked against live
 * Google Search results (see `needsWebCheck`).
 *
 * Streams progress as SSE, because a run makes one Azure call per segment plus a
 * web lookup per unsure claim and can take a minute:
 *   data: {"stage":"extracting","segmentsDone":i,...}    — reading part i
 *   data: {"stage":"checking","total":N,...}             — claims found, lookups starting
 *   data: {"finding":FactCheckFinding}                   — one per claim, as it settles
 *   data: {"error":"..."}                                — run failed
 *   data: [DONE]
 * Findings stream in completion order, so the client sorts them for display.
 *
 * Closing the connection cancels the run: remaining web lookups are abandoned
 * rather than billed for. Nothing is persisted.
 */
router.post('/', async (req: Request, res: Response) => {
  const { text, knownEntityNames } = req.body as { text?: string; knownEntityNames?: string[] };
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    res.status(400).json({ error: 'text required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // The client aborts the fetch when the author hits Stop or closes the report.
  // Watch the response, not the request: `req`'s own 'close' fires as soon as the
  // request body has been read, which is every request, not just a cancelled one.
  let cancelled = false;
  res.on('close', () => {
    // A close before we finished writing is the client hanging up on us.
    if (!res.writableEnded) cancelled = true;
  });

  const send = (payload: FactCheckStreamEvent): void => {
    if (cancelled) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const allSegments = segmentText(text);
  const segments = allSegments.slice(0, MAX_SEGMENTS);
  const truncated = allSegments.length > MAX_SEGMENTS;
  const checkedText = segments.join('');

  send({ stage: 'extracting', segmentsTotal: segments.length, segmentsDone: 0 });

  const entityList = Array.isArray(knownEntityNames)
    ? knownEntityNames.filter(n => typeof n === 'string' && n.trim().length > 0)
    : [];

  const entityPreamble = entityList.length > 0
    ? `Known story entities — these are fictional, never fact-check claims about them: ${entityList.join(', ')}\n\n`
    : '';

  /** Reads one segment and returns its claims. A segment that comes back
   * unreadable yields nothing rather than failing the whole run — losing one
   * part of a long chapter beats losing the whole report. */
  const extractSegment = async (segment: string, index: number): Promise<FactCheckFinding[]> => {
    // A segment is one slice of a longer chapter, so say so: without this the
    // model reads a mid-chapter excerpt as a chapter that opens mid-sentence.
    const positionNote = segments.length > 1
      ? `This is part ${index + 1} of ${segments.length} of one chapter. Check only the prose below; it may begin or end mid-scene.\n\n`
      : '';
    const completion = await client.chat.completions.create({
      model: config.foundry.highModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${entityPreamble}${positionNote}Chapter prose:\n${segment}` },
      ],
      response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? '{}') as { findings?: unknown };
    if (!Array.isArray(parsed.findings)) return [];
    // Quotes are matched against the whole checked chapter rather than this
    // segment, so a quote that straddles a seam still anchors.
    return parsed.findings
      .map(f => toFinding(f, checkedText))
      .filter((f): f is FactCheckFinding => f !== null);
  };

  try {
    // Segments are read a few at a time — a twelve-part chapter read strictly in
    // sequence would keep the author waiting far longer than it needs to.
    const perSegment: FactCheckFinding[][] = segments.map(() => []);
    let done = 0;
    let readable = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!cancelled) {
        const index = next++;
        if (index >= segments.length) return;
        try {
          perSegment[index] = await extractSegment(segments[index], index);
          readable++;
        } catch (err) {
          // A content filter or an unparseable reply kills this segment only.
          console.error(`Fact check: part ${index + 1}/${segments.length} failed:`, err);
        }
        done++;
        send({ stage: 'extracting', segmentsTotal: segments.length, segmentsDone: done });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(EXTRACT_CONCURRENCY, segments.length) }, worker),
    );

    // Every part failing is a real failure; some parts failing is a thinner
    // report, which is still worth showing.
    if (readable === 0 && !cancelled) {
      send({ error: 'The fact check came back unreadable — please try again.' });
      return;
    }

    let claims = perSegment.flat();

    // Sort before grounding so the claims most worth a web lookup — the disputes —
    // are the ones inside the grounding budget.
    claims = dedupe(claims).sort(
      (a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || b.confidence - a.confidence,
    );

    // Only the claims the first pass was unsure of go out to the web; the rest
    // are already settled, so searching them would buy nothing.
    const searchAvailable = isSearchGroundingEnabled();
    // The budget grows with the chapter, so a long chapter's later claims get
    // the same shot at a web check as its opening ones.
    const groundingBudget = Math.min(
      MAX_GROUNDED_CLAIMS,
      GROUNDED_CLAIMS_PER_SEGMENT * segments.length,
    );
    const toGround = searchAvailable
      ? claims.filter(needsWebCheck).slice(0, groundingBudget)
      : [];
    const groundingIds = new Set(toGround.map(f => f.id));

    send({
      stage: 'checking',
      total: claims.length,
      webCheckCount: toGround.length,
      truncated,
      searchAvailable,
    });

    // Report the confident findings straight away — they need no further work.
    for (const finding of claims) {
      if (!groundingIds.has(finding.id)) send({ finding });
    }

    if (toGround.length > 0) {
      // Each claim is emitted the moment its lookup lands, so the report fills in
      // as the run proceeds instead of appearing all at once at the end.
      await groundClaims(
        toGround.map(f => ({ claim: f.claim, quote: f.quote })),
        {
          isCancelled: () => cancelled,
          onResult: (index, grounded) => send({
            finding: grounded ? withGroundedVerdict(toGround[index], grounded) : toGround[index],
          }),
        },
      );
    }
  } catch (err) {
    console.error('Fact check error:', err);
    const isContentFilter = (err as { code?: string })?.code === 'content_filter';
    send({
      error: isContentFilter
        ? 'Your chapter was blocked by the content filter. Try fact-checking a shorter section.'
        : 'The fact check failed. Please try again.',
    });
  } finally {
    if (!cancelled) res.write('data: [DONE]\n\n');
    res.end();
  }
});

export default router;
