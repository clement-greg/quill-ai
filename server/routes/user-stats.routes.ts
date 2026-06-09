import { Router, Request, Response } from 'express';
import { getContainer } from '../cosmos';
import { withOwnerFilter } from '../owner-guard';

const router = Router();

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(html: string): string[] {
  const text = stripHtml(html || '');
  return text ? text.split(/\s+/) : [];
}

/**
 * Multiset (bag-of-words) diff: counts how many times each word appears in
 * prev vs curr. Words appearing more in curr → added; fewer → deleted.
 * O(n) time and space, no external dependencies.
 */
function wordDiff(prevTokens: string[], currTokens: string[]): { added: number; removed: number } {
  const counts = new Map<string, number>();

  for (const w of prevTokens) counts.set(w, (counts.get(w) ?? 0) - 1);
  for (const w of currTokens) counts.set(w, (counts.get(w) ?? 0) + 1);

  let added = 0;
  let removed = 0;
  for (const delta of counts.values()) {
    if (delta > 0) added += delta;
    else if (delta < 0) removed += -delta;
  }
  return { added, removed };
}

// GET /api/user-stats/writing?days=365
// Returns per-day word-diff counts derived from chapter-version history.
// Note: the first version of each chapter within the window is diffed against
// an empty baseline (0 words), so the very first save of an old chapter may
// overstate the "added" count.
router.get('/writing', async (req: Request, res: Response): Promise<void> => {
  try {
    const days = Math.min(Math.max(parseInt(req.query['days'] as string) || 365, 1), 365);
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceIso = since.toISOString();

    const container = getContainer('chapter-versions');

    // Cross-partition query (no partition key = fan-out).
    // ORDER BY omitted to avoid requiring a composite index; we sort below.
    const { resources } = await container.items
      .query(withOwnerFilter(req, {
        query: `SELECT c.chapterId, c.savedAt, c.content
                FROM c
                WHERE c.savedAt >= @since`,
        parameters: [{ name: '@since', value: sinceIso }],
      }))
      .fetchAll();

    // Sort by chapter then time so consecutive diffs are in the right order
    resources.sort((a: any, b: any) => {
      const cmp = (a.chapterId as string).localeCompare(b.chapterId);
      return cmp !== 0 ? cmp : (a.savedAt as string).localeCompare(b.savedAt);
    });

    // Group versions by chapter
    const byChapter = new Map<string, { savedAt: string; content: string }[]>();
    for (const v of resources) {
      if (!byChapter.has(v.chapterId)) byChapter.set(v.chapterId, []);
      byChapter.get(v.chapterId)!.push(v);
    }

    interface DayBucket { added: number; deleted: number }
    const dailyMap = new Map<string, DayBucket>();

    const bucket = (date: string): DayBucket => {
      if (!dailyMap.has(date)) dailyMap.set(date, { added: 0, deleted: 0 });
      return dailyMap.get(date)!;
    };

    for (const versions of byChapter.values()) {
      let prevTokens: string[] = [];
      for (const version of versions) {
        const currTokens = tokenize(version.content);
        const { added, removed } = wordDiff(prevTokens, currTokens);
        const date = version.savedAt.slice(0, 10);
        const b = bucket(date);
        b.added += added;
        b.deleted += removed;
        prevTokens = currTokens;
      }
    }

    const daily = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { added, deleted }]) => ({ date, wordsAdded: added, wordsDeleted: deleted }));

    const totalAdded   = daily.reduce((s, d) => s + d.wordsAdded, 0);
    const totalDeleted = daily.reduce((s, d) => s + d.wordsDeleted, 0);
    const activeDays   = daily.filter(d => d.wordsAdded > 0 || d.wordsDeleted > 0).length;

    // Current streak: consecutive active days up to and including today
    // (if today has no writing yet, count from yesterday backward)
    const dateSet = new Set(daily.map(d => d.date));
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    let streak = 0;
    const startOffset = dateSet.has(todayStr) ? 0 : 1;
    for (let i = startOffset; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      if (dateSet.has(ds)) streak++;
      else break;
    }

    res.json({
      daily,
      summary: {
        totalAdded,
        totalDeleted,
        netWords: totalAdded - totalDeleted,
        activeDays,
        totalVersionsSaved: resources.length,
        currentStreak: streak,
      },
    });
  } catch (err) {
    console.error('[user-stats] Error computing writing stats:', err);
    res.status(500).json({ error: 'Failed to compute writing stats' });
  }
});

export default router;
