import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { AzureOpenAI } from 'openai';
import { getContainer } from '../cosmos';
import {
  EntityRelationship,
  DiagramLayout,
  RelationshipType,
  RelationshipExtractionResult,
  RelationshipAddProposal,
  ApplyRelationshipProposalsRequest,
} from '../../shared/models/entity-relationship.model';
import { Entity } from '../../shared/models/entity.model';
import { Chapter } from '../../shared/models/chapter.model';
import { withOwnerFilter, readOwnedItem } from '../owner-guard';
import config from '../config';

const router = Router();
const relationshipContainer = getContainer('entity-relationships');
const layoutContainer = getContainer('diagram-layouts');
const entitiesContainer = getContainer('entities');
const chaptersContainer = getContainer('chapters');

const aiClient = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

const VALID_RELATIONSHIP_TYPES = new Set<RelationshipType>([
  'parent', 'child', 'sibling', 'spouse', 'friend', 'enemy',
  'coworker', 'mentor', 'student', 'rival', 'ally', 'boss', 'subordinate',
]);

const RELATIONSHIP_EXTRACTION_PROMPT = `You are a story analyst for a fiction-writing app. You extract character relationships from chapter text.

You receive:
1. "Known entities": the characters, places, and things in this series, each with an "id".
2. "Existing relationships": relationships already recorded for this series.
3. The chapter text.

Return a JSON object with exactly one key:

"adds": NEW relationships clearly established between characters in the chapter that are NOT already in "Existing relationships". Each item must have:
  - "sourceEntityId": the id of one entity (must be a provided entity id)
  - "targetEntityId": the id of the other entity (must be a provided entity id, different from source)
  - "relationshipType": exactly one of: parent, child, sibling, spouse, friend, enemy, coworker, mentor, student, rival, ally, boss, subordinate
  - "description": one sentence describing the relationship as shown in the text (optional)

Rules:
- Only include relationships that are clearly and explicitly established by the chapter text.
- Both entities must be from the "Known entities" list; use their exact ids.
- Do not duplicate existing relationships (check both directions).
- Only include PERSON-to-PERSON relationships; ignore places and things.
- A typical chapter yields zero to three new relationships. Empty array is a perfectly fine answer.
- Respond only with the raw JSON object, no markdown or code blocks.`;

const MAX_EXTRACTION_CHARS = 60000;

// ── Relationships ──────────────────────────────────────────

// GET relationships by series
router.get('/series/:seriesId', async (req: Request, res: Response) => {
  try {
    const seriesId = req.params['seriesId'] as string;
    const { resources } = await relationshipContainer.items
      .query(withOwnerFilter(req, {
        query: 'SELECT * FROM c WHERE c.seriesId = @seriesId',
        parameters: [{ name: '@seriesId', value: seriesId }],
      }))
      .fetchAll();
    res.json(resources as EntityRelationship[]);
  } catch (err) {
    console.error('Error fetching relationships:', err);
    res.status(500).json({ error: 'Failed to fetch relationships' });
  }
});

// POST create relationship
router.post('/', async (req: Request, res: Response) => {
  try {
    const rel: EntityRelationship = req.body;
    if (!rel.seriesId || !rel.sourceEntityId || !rel.targetEntityId || !rel.relationshipType) {
      res.status(400).json({ error: 'seriesId, sourceEntityId, targetEntityId, and relationshipType are required' });
      return;
    }
    const now = new Date().toISOString();
    rel.owner = rel.owner || req.user!.email;
    rel.createdBy = req.user!.email;
    rel.createdAt = now;
    rel.modifiedBy = req.user!.email;
    rel.modifiedAt = now;
    const { resource } = await relationshipContainer.items.create<EntityRelationship>(rel);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error creating relationship:', err);
    res.status(500).json({ error: 'Failed to create relationship' });
  }
});

// PUT update relationship
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const rel: EntityRelationship = {
      ...req.body,
      id,
      owner: req.body.owner || req.user!.email,
      modifiedBy: req.user!.email,
      modifiedAt: new Date().toISOString(),
    };
    const { resource } = await relationshipContainer.item(id, id).replace<EntityRelationship>(rel);
    res.json(resource);
  } catch (err) {
    console.error('Error updating relationship:', err);
    res.status(500).json({ error: 'Failed to update relationship' });
  }
});

// DELETE relationship
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    await relationshipContainer.item(id, id).delete();
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting relationship:', err);
    res.status(500).json({ error: 'Failed to delete relationship' });
  }
});

// ── Chapter relationship extraction ───────────────────────────────────────────

// POST analyze chapter text and propose new relationships. Nothing is persisted.
router.post('/extract-from-chapter', async (req: Request, res: Response) => {
  try {
    const { chapterId, seriesId, text } = req.body as { chapterId?: string; seriesId?: string; text?: string };
    if (!chapterId || !seriesId || typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ error: 'chapterId, seriesId and text are required' });
      return;
    }
    const chapter = await readOwnedItem<Chapter>(chaptersContainer, chapterId, chapterId, req);
    if (!chapter) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }

    const { resources: entityResources } = await entitiesContainer.items
      .query(withOwnerFilter(req, {
        query: 'SELECT c.id, c.name, c.type, c.deleted, c.archived, c.isNarrator FROM c WHERE c.seriesId = @seriesId',
        parameters: [{ name: '@seriesId', value: seriesId }],
      }))
      .fetchAll();
    const entities = (entityResources as Pick<Entity, 'id' | 'name' | 'type' | 'deleted' | 'archived' | 'isNarrator'>[])
      .filter(e => !e.deleted && !e.archived && !e.isNarrator);
    const entityById = new Map(entities.map(e => [e.id, e]));

    const { resources: existingRels } = await relationshipContainer.items
      .query(withOwnerFilter(req, {
        query: 'SELECT c.sourceEntityId, c.targetEntityId, c.relationshipType FROM c WHERE c.seriesId = @seriesId',
        parameters: [{ name: '@seriesId', value: seriesId }],
      }))
      .fetchAll();

    const userContent = [
      'Known entities (PERSON type only):',
      JSON.stringify(entities.filter(e => e.type === 'PERSON').map(e => ({ id: e.id, name: e.name }))),
      '',
      'Existing relationships:',
      JSON.stringify(existingRels),
      '',
      'Chapter text:',
      text.slice(0, MAX_EXTRACTION_CHARS),
    ].join('\n');

    const completion = await aiClient.chat.completions.create({
      model: config.foundry.fullModel,
      messages: [
        { role: 'system', content: RELATIONSHIP_EXTRACTION_PROMPT },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message?.content ?? '{"adds":[]}';
    let parsed: { adds?: unknown } = {};
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }

    const existingPairs = new Set(
      (existingRels as { sourceEntityId: string; targetEntityId: string }[])
        .flatMap(r => [`${r.sourceEntityId}:${r.targetEntityId}`, `${r.targetEntityId}:${r.sourceEntityId}`]),
    );

    const adds: RelationshipAddProposal[] = (Array.isArray(parsed.adds) ? parsed.adds : [])
      .filter((a: { sourceEntityId?: unknown; targetEntityId?: unknown; relationshipType?: unknown }) =>
        a &&
        typeof a.sourceEntityId === 'string' && entityById.has(a.sourceEntityId) &&
        typeof a.targetEntityId === 'string' && entityById.has(a.targetEntityId) &&
        a.sourceEntityId !== a.targetEntityId &&
        typeof a.relationshipType === 'string' && VALID_RELATIONSHIP_TYPES.has(a.relationshipType as RelationshipType) &&
        !existingPairs.has(`${a.sourceEntityId}:${a.targetEntityId}`))
      .map((a: { sourceEntityId: string; targetEntityId: string; relationshipType: string; description?: unknown }) => ({
        sourceEntityId: a.sourceEntityId,
        sourceEntityName: entityById.get(a.sourceEntityId)!.name,
        targetEntityId: a.targetEntityId,
        targetEntityName: entityById.get(a.targetEntityId)!.name,
        relationshipType: a.relationshipType as RelationshipType,
        description: typeof a.description === 'string' && a.description.trim() ? a.description.trim() : undefined,
      }));

    const result: RelationshipExtractionResult = { adds };
    res.json(result);
  } catch (err) {
    console.error('Error extracting relationships from chapter:', err);
    res.status(500).json({ error: 'Failed to analyze chapter for relationships' });
  }
});

// POST persist the user-accepted relationship proposals.
router.post('/apply-chapter-proposals', async (req: Request, res: Response) => {
  try {
    const { chapterId, seriesId, adds = [] } = req.body as ApplyRelationshipProposalsRequest;
    if (!chapterId || !seriesId) {
      res.status(400).json({ error: 'chapterId and seriesId are required' });
      return;
    }
    const chapter = await readOwnedItem<Chapter>(chaptersContainer, chapterId, chapterId, req);
    if (!chapter) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }

    const now = new Date().toISOString();
    let added = 0;

    for (const add of Array.isArray(adds) ? adds : []) {
      if (!add?.sourceEntityId || !add?.targetEntityId || !add?.relationshipType) continue;
      if (!VALID_RELATIONSHIP_TYPES.has(add.relationshipType)) continue;

      const rel: EntityRelationship = {
        id: randomUUID(),
        seriesId,
        sourceEntityId: add.sourceEntityId,
        targetEntityId: add.targetEntityId,
        relationshipType: add.relationshipType,
        description: add.description?.trim() || undefined,
        owner: req.user!.email,
        createdBy: req.user!.email,
        createdAt: now,
        modifiedBy: req.user!.email,
        modifiedAt: now,
      };
      try {
        await relationshipContainer.items.create<EntityRelationship>(rel);
        added++;
      } catch (createErr) {
        console.error(`apply-chapter-proposals: failed to create relationship:`, createErr);
      }
    }

    res.json({ added });
  } catch (err) {
    console.error('Error applying relationship proposals:', err);
    res.status(500).json({ error: 'Failed to apply relationship proposals' });
  }
});

// GET relationships by entity (enriched with partner entity info)
router.get('/entity/:entityId', async (req: Request, res: Response) => {
  try {
    const entityId = req.params['entityId'] as string;

    const { resources: relResources } = await relationshipContainer.items
      .query(withOwnerFilter(req, {
        query: 'SELECT * FROM c WHERE c.sourceEntityId = @entityId OR c.targetEntityId = @entityId',
        parameters: [{ name: '@entityId', value: entityId }],
      }))
      .fetchAll();

    const rels = relResources as EntityRelationship[];

    if (rels.length === 0) {
      res.json([]);
      return;
    }

    const partnerIds = [...new Set(rels.map(r =>
      r.sourceEntityId === entityId ? r.targetEntityId : r.sourceEntityId
    ))];
    const params = partnerIds.map((id, i) => ({ name: `@id${i}`, value: id }));
    const inClause = params.map(p => p.name).join(', ');

    const { resources: partnerResources } = await entitiesContainer.items
      .query(withOwnerFilter(req, {
        query: `SELECT c.id, c.name, c.type, c.thumbnailUrl, c.deleted, c.archived FROM c WHERE c.id IN (${inClause})`,
        parameters: params,
      }))
      .fetchAll();

    const partnerMap = new Map(
      (partnerResources as Pick<Entity, 'id' | 'name' | 'type' | 'thumbnailUrl' | 'deleted' | 'archived'>[])
        .filter(e => !e.deleted && !e.archived)
        .map(e => [e.id, e])
    );

    const result = rels
      .map(r => {
        const isSource = r.sourceEntityId === entityId;
        const partnerId = isSource ? r.targetEntityId : r.sourceEntityId;
        const partner = partnerMap.get(partnerId);
        if (!partner) return null;
        return {
          id: r.id,
          partnerEntityId: partnerId,
          partnerEntityName: partner.name,
          partnerEntityType: partner.type,
          partnerEntityThumbnailUrl: partner.thumbnailUrl,
          relationshipType: r.relationshipType,
          description: r.description,
          direction: isSource ? 'source' : 'target',
        };
      })
      .filter(Boolean);

    res.json(result);
  } catch (err) {
    console.error('Error fetching relationships by entity:', err);
    res.status(500).json({ error: 'Failed to fetch relationships' });
  }
});

// ── Diagram Layout ─────────────────────────────────────────

// GET layout for a series
router.get('/layout/:seriesId', async (req: Request, res: Response) => {
  try {
    const seriesId = req.params['seriesId'] as string;
    const { resources } = await layoutContainer.items
      .query(withOwnerFilter(req, {
        query: 'SELECT * FROM c WHERE c.seriesId = @seriesId',
        parameters: [{ name: '@seriesId', value: seriesId }],
      }))
      .fetchAll();
    res.json(resources[0] ?? null);
  } catch (err) {
    console.error('Error fetching diagram layout:', err);
    res.status(500).json({ error: 'Failed to fetch diagram layout' });
  }
});

// PUT upsert layout for a series
router.put('/layout/:seriesId', async (req: Request, res: Response) => {
  try {
    const seriesId = req.params['seriesId'] as string;
    const layout: DiagramLayout = {
      ...req.body,
      seriesId,
      modifiedBy: req.user!.email,
      modifiedAt: new Date().toISOString(),
    };
    if (!layout.createdBy) {
      layout.createdBy = req.user!.email;
      layout.createdAt = new Date().toISOString();
    }
    if (!layout.owner) {
      layout.owner = req.user!.email;
    }
    const { resource } = await layoutContainer.items.upsert<DiagramLayout>(layout);
    res.json(resource);
  } catch (err) {
    console.error('Error saving diagram layout:', err);
    res.status(500).json({ error: 'Failed to save diagram layout' });
  }
});

export default router;
