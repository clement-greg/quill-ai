import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getContainer } from '../services/cosmos';
import {
  FactCheckReport,
  FactCheckResolveRequest,
  SavedFactCheckFinding,
} from '../../shared/models/fact-check.model';
import { readOwnedItem, withOwnerFilter } from '../middleware/owner-guard';

/**
 * Saved fact-check reports. A run streams from /api/fact-check and is thrown
 * away unless the client posts it here; once saved it becomes a durable record
 * the author can come back to and work through, ticking off each finding as
 * they either correct the prose or accept the inaccuracy.
 *
 * Reports accumulate rather than overwrite — re-checking a chapter adds a run
 * alongside its predecessors, so the author can see what an earlier pass said.
 *
 * Storage note: these share the `chapter-versions` container rather than having
 * one of their own — the database sits at the 25-container ceiling for a
 * shared-throughput offer, and version snapshots are partitioned by exactly the
 * same key. `docType` keeps the two apart, and EVERY query on this container,
 * here and in chapter-versions.routes, must filter on it.
 */
const router = Router();
const container = getContainer('chapter-versions');

/** Marks a document in the shared container as a fact-check report. */
const DOC_TYPE = 'fact-check-report';

/** Guards against a client posting an unbounded blob into one document. */
const MAX_FINDINGS = 500;

/** Strips a client-supplied finding down to the fields the report owns, so a
 * saved report can't smuggle in extra keys. Returns null when unusable. */
function toSavedFinding(raw: unknown): SavedFactCheckFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Partial<SavedFactCheckFinding>;
  if (!f.id || !f.claim || !f.verdict) return null;
  return {
    id: String(f.id),
    claim: String(f.claim),
    ...(f.quote ? { quote: String(f.quote) } : {}),
    category: f.category ?? 'other',
    verdict: f.verdict,
    confidence: typeof f.confidence === 'number' ? f.confidence : 50,
    explanation: String(f.explanation ?? ''),
    ...(f.remedy ? { remedy: String(f.remedy) } : {}),
    grounded: f.grounded === true,
    ...(Array.isArray(f.sources) && f.sources.length > 0 ? { sources: f.sources } : {}),
    // A run has never been triaged, so check-off state always starts clean.
    resolved: false,
  };
}

// GET every saved report for a chapter, newest run first.
router.get('/chapter/:chapterId', async (req: Request, res: Response) => {
  try {
    const chapterId = req.params['chapterId'] as string;
    const { resources } = await container.items
      .query(withOwnerFilter(req, {
        query:
          'SELECT * FROM c WHERE c.chapterId = @chapterId AND c.docType = @docType ' +
          'ORDER BY c.runAt DESC',
        parameters: [
          { name: '@chapterId', value: chapterId },
          { name: '@docType', value: DOC_TYPE },
        ],
      }), { partitionKey: chapterId })
      .fetchAll();
    res.json(resources as FactCheckReport[]);
  } catch (err) {
    console.error('Error fetching fact check reports:', err);
    res.status(500).json({ error: 'Failed to fetch fact check reports' });
  }
});

// POST save a finished run as a new report.
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<FactCheckReport>;
    if (!body.chapterId) {
      res.status(400).json({ error: 'chapterId is required' });
      return;
    }
    const findings = (Array.isArray(body.findings) ? body.findings : [])
      .slice(0, MAX_FINDINGS)
      .map(toSavedFinding)
      .filter((f): f is SavedFactCheckFinding => f !== null);
    if (findings.length === 0) {
      res.status(400).json({ error: 'at least one finding is required' });
      return;
    }

    const now = new Date().toISOString();
    const report: FactCheckReport = {
      id: uuidv4(),
      docType: DOC_TYPE,
      chapterId: body.chapterId,
      runAt: body.runAt ?? now,
      ...(body.chapterTitle ? { chapterTitle: body.chapterTitle } : {}),
      findings,
      // Trust the client's `total` only when it's at least what it sent us; a
      // stopped run reports more claims than it managed to check.
      total: typeof body.total === 'number' && body.total > findings.length
        ? body.total
        : findings.length,
      truncated: body.truncated === true,
      stopped: body.stopped === true,
      searchAvailable: body.searchAvailable === true,
      owner: req.user!.email,
      createdBy: req.user!.email,
      createdAt: now,
    };
    const { resource } = await container.items.create<FactCheckReport>(report);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error saving fact check report:', err);
    res.status(500).json({ error: 'Failed to save fact check report' });
  }
});

// PATCH check one finding off, or put it back on the list.
router.patch('/:id/findings/:findingId', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const findingId = req.params['findingId'] as string;
    const { chapterId, resolved } = req.body as Partial<FactCheckResolveRequest>;
    if (!chapterId) {
      res.status(400).json({ error: 'chapterId is required' });
      return;
    }
    if (typeof resolved !== 'boolean') {
      res.status(400).json({ error: 'resolved must be a boolean' });
      return;
    }

    const report = await readOwnedItem<FactCheckReport>(container, id, chapterId, req);
    // A version snapshot shares this container and this partition, so an id that
    // resolves to one is not a report the author can triage.
    if (!report || report.docType !== DOC_TYPE) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }
    if (!report.findings.some(f => f.id === findingId)) {
      res.status(404).json({ error: 'Finding not found' });
      return;
    }

    const now = new Date().toISOString();
    const updated: FactCheckReport = {
      ...report,
      findings: report.findings.map(f =>
        f.id === findingId
          // Un-ticking drops the timestamp too, so a re-tick dates from the
          // moment the author actually settled it.
          ? { ...f, resolved, ...(resolved ? { resolvedAt: now } : { resolvedAt: undefined }) }
          : f,
      ),
      modifiedBy: req.user!.email,
      modifiedAt: now,
    };
    const { resource } = await container.item(id, chapterId).replace(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error updating fact check finding:', err);
    res.status(500).json({ error: 'Failed to update fact check finding' });
  }
});

// DELETE a saved report the author is done with.
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const chapterId = req.query['chapterId'] as string | undefined;
    if (!chapterId) {
      res.status(400).json({ error: 'chapterId is required' });
      return;
    }
    const report = await readOwnedItem<FactCheckReport>(container, id, chapterId, req);
    if (!report || report.docType !== DOC_TYPE) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }
    await container.item(id, chapterId).delete();
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting fact check report:', err);
    res.status(500).json({ error: 'Failed to delete fact check report' });
  }
});

export default router;
