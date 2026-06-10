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
  let added = 0, removed = 0;
  for (const delta of counts.values()) {
    if (delta > 0) added += delta;
    else if (delta < 0) removed += -delta;
  }
  return { added, removed };
}

function toLocalDateStr(isoUtc: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(isoUtc));
}

// GET /api/user-stats/writing?days=365&tz=America/New_York
router.get('/writing', async (req: Request, res: Response): Promise<void> => {
  try {
    const days = Math.min(Math.max(parseInt(req.query['days'] as string) || 365, 1), 365);
    const rawTz = req.query['tz'] as string | undefined;
    let tz = 'UTC';
    if (rawTz) {
      try { Intl.DateTimeFormat(undefined, { timeZone: rawTz }); tz = rawTz; } catch { /* invalid, use UTC */ }
    }
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceIso = since.toISOString();

    // Fetch an extra 60-day baseline window before the stats window so the first
    // in-window version of each chapter is diffed against real prior content
    // rather than an empty string. This prevents inflated "added" counts.
    const BASELINE_DAYS = 60;
    const baseSince = new Date();
    baseSince.setDate(baseSince.getDate() - days - BASELINE_DAYS);
    const baseSinceIso = baseSince.toISOString();

    const versionsContainer = getContainer('chapter-versions');

    // Cross-partition query. ORDER BY omitted to avoid needing a composite index.
    const { resources } = await versionsContainer.items
      .query(withOwnerFilter(req, {
        query: `SELECT c.chapterId, c.savedAt, c.content FROM c WHERE c.savedAt >= @since`,
        parameters: [{ name: '@since', value: baseSinceIso }],
      }))
      .fetchAll();

    // Sort by chapter then time so diffs are computed in the right order
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

    // Per-chapter totals accumulated alongside per-day totals
    interface ChapterTotals { added: number; deleted: number; lastSaved: string }
    const chapterTotals = new Map<string, ChapterTotals>();

    for (const [chapterId, versions] of byChapter.entries()) {
      let prevTokens: string[] = [];
      let chapAdded = 0, chapDeleted = 0, lastSaved = '';
      for (const version of versions) {
        const currTokens = tokenize(version.content);
        const { added, removed } = wordDiff(prevTokens, currTokens);
        // Only count stats for versions inside the requested stats window;
        // baseline versions (in the earlier 60-day buffer) only advance prevTokens.
        if (version.savedAt >= sinceIso) {
          const date = toLocalDateStr(version.savedAt, tz);
          const b = bucket(date);
          b.added += added;
          b.deleted += removed;
          chapAdded += added;
          chapDeleted += removed;
          lastSaved = date;
        }
        prevTokens = currTokens;
      }
      chapterTotals.set(chapterId, { added: chapAdded, deleted: chapDeleted, lastSaved });
    }

    const daily = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { added, deleted }]) => ({ date, wordsAdded: added, wordsDeleted: deleted }));

    const totalAdded   = daily.reduce((s, d) => s + d.wordsAdded, 0);
    const totalDeleted = daily.reduce((s, d) => s + d.wordsDeleted, 0);
    const activeDays   = daily.filter(d => d.wordsAdded > 0 || d.wordsDeleted > 0).length;

    // Streak: consecutive active days up to and including today
    const dateSet = new Set(daily.map(d => d.date));
    const today = new Date();
    const todayStr = toLocalDateStr(today.toISOString(), tz);
    let streak = 0;
    const startOffset = dateSet.has(todayStr) ? 0 : 1;
    for (let i = startOffset; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const ds = toLocalDateStr(d.toISOString(), tz);
      if (dateSet.has(ds)) streak++;
      else break;
    }

    function proxyImageUrl(azureUrl: string | undefined): string | null {
      if (!azureUrl) return null;
      const filename = azureUrl.split('/').pop();
      return filename ? `/api/image/${filename}` : null;
    }

    // Fetch chapter metadata in parallel (chapters partition key = /id → efficient point reads)
    const chaptersContainer = getContainer('chapters');
    const chapterIds = [...chapterTotals.keys()];

    interface ChapterMeta { title: string; thumbnailUrl: string | null }
    const chapterMetaMap = new Map<string, ChapterMeta>();

    await Promise.all(
      chapterIds.map(async (id) => {
        try {
          const { resource } = await chaptersContainer.item(id, id).read<{
            id: string;
            title?: string;
            imageThumbnailUrl?: string;
            imageUrl?: string;
          }>();
          chapterMetaMap.set(id, {
            title: resource?.title?.trim() || 'Untitled Chapter',
            thumbnailUrl: proxyImageUrl(resource?.imageThumbnailUrl ?? resource?.imageUrl),
          });
        } catch {
          chapterMetaMap.set(id, { title: 'Untitled Chapter', thumbnailUrl: null });
        }
      })
    );

    const byChapterStats = chapterIds
      .map(id => {
        const { added, deleted, lastSaved } = chapterTotals.get(id)!;
        const meta = chapterMetaMap.get(id)!;
        return {
          chapterId: id,
          title: meta.title,
          thumbnailUrl: meta.thumbnailUrl,
          wordsAdded: added,
          wordsDeleted: deleted,
          netWords: added - deleted,
          lastSaved,
        };
      })
      // Drop chapters with no activity in this window
      .filter(ch => ch.wordsAdded > 0 || ch.wordsDeleted > 0)
      .sort((a, b) => (b.wordsAdded + b.wordsDeleted) - (a.wordsAdded + a.wordsDeleted));

    res.json({
      daily,
      byChapter: byChapterStats,
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
