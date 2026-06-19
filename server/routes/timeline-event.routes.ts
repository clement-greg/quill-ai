import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { AzureOpenAI } from 'openai';
import { getContainer } from '../cosmos';
import {
  TimelineEvent,
  TimelineEventFields,
  TimelineAddProposal,
  TimelineUpdateProposal,
  TimelineRemoveProposal,
  TimelineExtractionResult,
  ApplyTimelineProposalsRequest,
} from '../../shared/models/timeline-event.model';
import { Entity } from '../../shared/models/entity.model';
import { Chapter } from '../../shared/models/chapter.model';
import { withOwnerFilter, readOwnedItem } from '../owner-guard';
import config from '../config';

const router = Router();
const container = getContainer('timeline-events');
const entitiesContainer = getContainer('entities');
const chaptersContainer = getContainer('chapters');

const aiClient = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

// GET all timeline events for an entity, in relative order
router.get('/entity/:entityId', async (req: Request, res: Response) => {
  try {
    const entityId = req.params['entityId'] as string;
    const { resources } = await container.items
      .query(
        withOwnerFilter(req, {
          query: 'SELECT * FROM c WHERE c.entityId = @entityId',
          parameters: [{ name: '@entityId', value: entityId }],
        }),
        { partitionKey: entityId },
      )
      .fetchAll();
    const events = (resources as TimelineEvent[]).sort(
      (a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)
    );
    res.json(events);
  } catch (err) {
    console.error('Error fetching timeline events:', err);
    res.status(500).json({ error: 'Failed to fetch timeline events' });
  }
});

// POST create new timeline event
router.post('/', async (req: Request, res: Response) => {
  try {
    const { entityId, name, timeframe, description, location, photo, sortOrder } = req.body as Partial<TimelineEvent>;
    if (!name?.trim()) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }
    if (!entityId) {
      res.status(400).json({ error: 'entityId is required' });
      return;
    }
    const entity = await readOwnedItem<Entity>(entitiesContainer, entityId, entityId, req);
    if (!entity) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    let resolvedSortOrder = sortOrder;
    if (typeof resolvedSortOrder !== 'number') {
      const { resources } = await container.items
        .query(withOwnerFilter(req, {
          query: 'SELECT VALUE MAX(c.sortOrder) FROM c WHERE c.entityId = @entityId',
          parameters: [{ name: '@entityId', value: entityId }],
        }))
        .fetchAll();
      const max = resources[0];
      resolvedSortOrder = typeof max === 'number' ? max + 1 : 0;
    }

    const now = new Date().toISOString();
    const event: TimelineEvent = {
      id: randomUUID(),
      entityId,
      seriesId: entity.seriesId,
      name: name.trim(),
      timeframe: timeframe?.trim() || undefined,
      description: description?.trim() || undefined,
      location: location?.trim() || undefined,
      photo: photo ?? undefined,
      sortOrder: resolvedSortOrder,
      source: 'manual',
      owner: req.user!.email,
      createdBy: req.user!.email,
      createdAt: now,
      modifiedBy: req.user!.email,
      modifiedAt: now,
    };
    const { resource } = await container.items.create<TimelineEvent>(event);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error creating timeline event:', err);
    res.status(500).json({ error: 'Failed to create timeline event' });
  }
});

// PUT update timeline event (entityId in body is the partition key and is immutable)
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const { entityId, name, timeframe, description, location, photo } = req.body as Partial<TimelineEvent>;
    if (!entityId) {
      res.status(400).json({ error: 'entityId is required' });
      return;
    }
    if (!name?.trim()) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }
    const existing = await readOwnedItem<TimelineEvent>(container, id, entityId, req);
    if (!existing) {
      res.status(404).json({ error: 'Timeline event not found' });
      return;
    }
    const updated: TimelineEvent = {
      ...existing,
      name: name.trim(),
      timeframe: timeframe?.trim() || undefined,
      description: description?.trim() || undefined,
      location: location?.trim() || undefined,
      photo: photo ?? undefined,
      modifiedBy: req.user!.email,
      modifiedAt: new Date().toISOString(),
    };
    const { resource } = await container.item(id, entityId).replace<TimelineEvent>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error updating timeline event:', err);
    res.status(500).json({ error: 'Failed to update timeline event' });
  }
});

// PATCH reorder timeline events for an entity (bulk sort-order update)
router.patch('/entity/:entityId/reorder', async (req: Request, res: Response) => {
  try {
    const entityId = req.params['entityId'] as string;
    const { ids }: { ids: string[] } = req.body;
    if (!Array.isArray(ids)) {
      res.status(400).json({ error: 'ids must be an array' });
      return;
    }
    const now = new Date().toISOString();
    await Promise.all(
      ids.map(async (id, index) => {
        const existing = await readOwnedItem<TimelineEvent>(container, id, entityId, req);
        if (existing && existing.sortOrder !== index) {
          const updated: TimelineEvent = { ...existing, sortOrder: index, modifiedBy: req.user!.email, modifiedAt: now };
          await container.item(id, entityId).replace<TimelineEvent>(updated);
        }
      }),
    );
    res.status(204).send();
  } catch (err) {
    console.error('Error reordering timeline events:', err);
    res.status(500).json({ error: 'Failed to reorder timeline events' });
  }
});

// DELETE timeline event. The photo blob is NOT deleted — event photos live in
// the entity's gallery and are managed through the entity photo endpoints.
router.delete('/:entityId/:id', async (req: Request, res: Response) => {
  try {
    const entityId = req.params['entityId'] as string;
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<TimelineEvent>(container, id, entityId, req);
    if (!existing) {
      res.status(404).json({ error: 'Timeline event not found' });
      return;
    }
    await container.item(id, entityId).delete();
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting timeline event:', err);
    res.status(500).json({ error: 'Failed to delete timeline event' });
  }
});

// ── Chapter timeline extraction ──────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a story analyst for a fiction-writing app. You maintain character timelines by analyzing chapter text.

You receive:
1. "Known entities": the characters, places, and things in this series, each with an "id".
2. "Existing timeline events": events previously extracted from THIS chapter, each with an "id".
3. The chapter text.

Return a JSON object with exactly three keys:

1. "adds": NEW major events in the chapter text that are not already covered by an existing timeline event. Each item must have:
   - "entityId": the id of the known entity (usually a character) the event most directly belongs to. Must be one of the provided entity ids. If no provided entity clearly owns the event, omit the event entirely.
   - "name": a short event title (under ten words)
   - "timeframe": free-form timing if the text establishes one (e.g. "Three years before the war"); omit when unknown
   - "description": one or two sentences describing the event as established by the text
   - For location: if the place clearly matches one of the known PLACE entities, provide "locationEntityId" with that entity's id. Otherwise provide "location" as a free-text string (city, country, region, landmark, or fictional place name). Never provide both. Omit both when the location is unknown or vague.

2. "updates": existing timeline events whose underlying facts have SUBSTANTIVELY changed in the chapter text — a different outcome, different participants, or materially different circumstances. Each item must have:
   - "id": the existing event id
   - "name", "timeframe", "description": the corrected values (always include "name"; reuse the current value for anything unchanged)
   - For location changes: provide "locationEntityId" if the new location is a known PLACE entity, or "location" as a free-text string if not. Omit both to leave location unchanged.
   - "reason": one short sentence explaining what substantively changed
   Never propose an update for rewording, tone, or trivial detail differences.

3. "removes": existing timeline events that are no longer supported by the chapter text (the event was cut from the chapter or no longer happens). Each item must have:
   - "id": the existing event id
   - "reason": one short sentence explaining why it should be removed

Rules for what counts as an event — these are CRITICAL:
- Only include VERY CONSEQUENTIAL, plot-defining events: deaths, births, marriages, betrayals, battles, major revelations or discoveries, irreversible decisions, life-changing injuries or transformations, gaining or losing something crucial, or the beginning or end of a major journey or relationship.
- EXCLUDE routine and mundane activities — shopping, cooking, meals, errands, travel between scenes, casual conversation — and minor emotional beats.
- A typical chapter yields zero to three events. Empty arrays are a perfectly good answer.
- Never invent events that are not in the text. Never reference entity or event ids that were not provided.
- Respond only with the raw JSON object, no markdown or code blocks.`;

const MAX_EXTRACTION_CHARS = 60000;

function normalizeFields(
  name: string,
  timeframe?: unknown,
  description?: unknown,
  location?: unknown,
  locationEntityId?: unknown,
): TimelineEventFields {
  return {
    name: name.trim(),
    timeframe: typeof timeframe === 'string' && timeframe.trim() ? timeframe.trim() : undefined,
    description: typeof description === 'string' && description.trim() ? description.trim() : undefined,
    location: typeof location === 'string' && location.trim() ? location.trim() : undefined,
    locationEntityId: typeof locationEntityId === 'string' && locationEntityId.trim() ? locationEntityId.trim() : undefined,
  };
}

function fieldsChanged(a: TimelineEventFields, b: TimelineEventFields): boolean {
  return a.name !== b.name ||
    (a.timeframe ?? '') !== (b.timeframe ?? '') ||
    (a.description ?? '') !== (b.description ?? '') ||
    (a.location ?? '') !== (b.location ?? '') ||
    (a.locationEntityId ?? '') !== (b.locationEntityId ?? '');
}

type PlaceEntity = Pick<Entity, 'id' | 'name' | 'type' | 'deleted' | 'archived'>;

/** Resolve locationEntityId + location from raw AI output. Returns both fields.
 *  The entity name is copied into `location` as a fallback string so that
 *  existing code that reads the plain location field keeps working.
 */
function resolveLocation(
  rawLocation: unknown,
  rawLocationEntityId: unknown,
  entityById: Map<string, PlaceEntity>,
  fallbackLocation?: string,
  fallbackLocationEntityId?: string,
): { location?: string; locationEntityId?: string } {
  // AI provided a PLACE entity reference — validate it
  if (typeof rawLocationEntityId === 'string' && rawLocationEntityId.trim()) {
    const entity = entityById.get(rawLocationEntityId.trim());
    if (entity && entity.type === 'PLACE') {
      return { locationEntityId: entity.id, location: entity.name };
    }
  }
  // AI provided a plain string
  if (typeof rawLocation === 'string' && rawLocation.trim()) {
    return { location: rawLocation.trim(), locationEntityId: undefined };
  }
  // AI said nothing about location — preserve existing values
  if (fallbackLocation !== undefined || fallbackLocationEntityId !== undefined) {
    return { location: fallbackLocation, locationEntityId: fallbackLocationEntityId };
  }
  return {};
}

// POST analyze chapter text and propose timeline changes. Nothing is persisted —
// the client presents the proposals for the user to accept or reject.
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
        query: 'SELECT c.id, c.name, c.type, c.deleted, c.archived FROM c WHERE c.seriesId = @seriesId',
        parameters: [{ name: '@seriesId', value: seriesId }],
      }))
      .fetchAll();
    const entities = (entityResources as Pick<Entity, 'id' | 'name' | 'type' | 'deleted' | 'archived'>[])
      .filter(e => !e.deleted && !e.archived);
    const entityById = new Map(entities.map(e => [e.id, e]));

    // Only events this process previously created for this chapter are candidates
    // for update/removal — manual events are never touched.
    const { resources: eventResources } = await container.items
      .query(withOwnerFilter(req, {
        query: 'SELECT * FROM c WHERE c.chapterId = @chapterId AND c.source = @source',
        parameters: [
          { name: '@chapterId', value: chapterId },
          { name: '@source', value: 'chapter' },
        ],
      }))
      .fetchAll();
    const existingEvents = eventResources as TimelineEvent[];
    const eventById = new Map(existingEvents.map(e => [e.id, e]));

    const userContent = [
      'Known entities:',
      JSON.stringify(entities.map(e => ({ id: e.id, name: e.name, type: e.type }))),
      '',
      'Existing timeline events previously extracted from this chapter:',
      JSON.stringify(existingEvents.map(e => ({
        id: e.id,
        entityId: e.entityId,
        name: e.name,
        timeframe: e.timeframe,
        description: e.description,
        location: e.location,
        locationEntityId: e.locationEntityId,
      }))),
      '',
      'Chapter text:',
      text.slice(0, MAX_EXTRACTION_CHARS),
    ].join('\n');

    const completion = await aiClient.chat.completions.create({
      model: config.foundry.fullModel,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message?.content ?? '{"adds":[],"updates":[],"removes":[]}';
    let parsed: { adds?: unknown; updates?: unknown; removes?: unknown } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }

    const adds: TimelineAddProposal[] = (Array.isArray(parsed.adds) ? parsed.adds : [])
      .filter((a: { entityId?: unknown; name?: unknown }) =>
        a && typeof a.entityId === 'string' && entityById.has(a.entityId) &&
        typeof a.name === 'string' && a.name.trim().length > 0)
      .map((a: { entityId: string; name: string; timeframe?: unknown; description?: unknown; location?: unknown; locationEntityId?: unknown }) => {
        const loc = resolveLocation(a.location, a.locationEntityId, entityById);
        return {
          entityId: a.entityId,
          entityName: entityById.get(a.entityId)!.name,
          ...normalizeFields(a.name, a.timeframe, a.description, loc.location, loc.locationEntityId),
        };
      });

    const updates: TimelineUpdateProposal[] = (Array.isArray(parsed.updates) ? parsed.updates : [])
      .filter((u: { id?: unknown; name?: unknown }) =>
        u && typeof u.id === 'string' && eventById.has(u.id) &&
        typeof u.name === 'string' && u.name.trim().length > 0)
      .map((u: { id: string; name: string; timeframe?: unknown; description?: unknown; location?: unknown; locationEntityId?: unknown; reason?: unknown }) => {
        const existing = eventById.get(u.id)!;
        const current = normalizeFields(existing.name, existing.timeframe, existing.description, existing.location, existing.locationEntityId);
        const aiChangedLocation = (typeof u.location === 'string' && u.location.trim()) ||
          (typeof u.locationEntityId === 'string' && u.locationEntityId.trim());
        const loc = aiChangedLocation
          ? resolveLocation(u.location, u.locationEntityId, entityById)
          : { location: current.location, locationEntityId: current.locationEntityId };
        const proposed: TimelineEventFields = {
          name: u.name.trim(),
          timeframe: typeof u.timeframe === 'string' && u.timeframe.trim() ? u.timeframe.trim() : current.timeframe,
          description: typeof u.description === 'string' && u.description.trim() ? u.description.trim() : current.description,
          location: loc.location,
          locationEntityId: loc.locationEntityId,
        };
        return {
          eventId: existing.id,
          entityId: existing.entityId,
          entityName: entityById.get(existing.entityId)?.name ?? 'Unknown entity',
          current,
          proposed,
          reason: typeof u.reason === 'string' ? u.reason : undefined,
        };
      })
      .filter(u => fieldsChanged(u.current, u.proposed));

    const updatedIds = new Set(updates.map(u => u.eventId));
    const removes: TimelineRemoveProposal[] = (Array.isArray(parsed.removes) ? parsed.removes : [])
      .filter((r: { id?: unknown }) =>
        r && typeof r.id === 'string' && eventById.has(r.id) && !updatedIds.has(r.id))
      .map((r: { id: string; reason?: unknown }) => {
        const existing = eventById.get(r.id)!;
        return {
          eventId: existing.id,
          entityId: existing.entityId,
          entityName: entityById.get(existing.entityId)?.name ?? 'Unknown entity',
          current: normalizeFields(existing.name, existing.timeframe, existing.description),
          reason: typeof r.reason === 'string' ? r.reason : undefined,
        };
      });

    const result: TimelineExtractionResult = { adds, updates, removes };
    res.json(result);
  } catch (err) {
    console.error('Error extracting timeline events from chapter:', err);
    res.status(500).json({ error: 'Failed to analyze chapter for timeline events' });
  }
});

// POST apply the user-accepted timeline proposals for a chapter.
router.post('/apply-chapter-proposals', async (req: Request, res: Response) => {
  try {
    const { chapterId, adds = [], updates = [], removes = [] } = req.body as ApplyTimelineProposalsRequest;
    if (!chapterId) {
      res.status(400).json({ error: 'chapterId is required' });
      return;
    }
    const chapter = await readOwnedItem<Chapter>(chaptersContainer, chapterId, chapterId, req);
    if (!chapter) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }

    const now = new Date().toISOString();
    let added = 0, updated = 0, removed = 0;

    // Creates — resolve the next sortOrder once per entity, then increment locally.
    const nextSortOrderByEntity = new Map<string, number>();
    for (const add of Array.isArray(adds) ? adds : []) {
      if (!add?.entityId || !add?.name?.trim()) continue;
      const entity = await readOwnedItem<Entity>(entitiesContainer, add.entityId, add.entityId, req);
      if (!entity) {
        console.warn(`apply-chapter-proposals: entity ${add.entityId} not found or not owned — skipping add "${add.name}"`);
        continue;
      }

      if (!nextSortOrderByEntity.has(add.entityId)) {
        const { resources } = await container.items
          .query(
            withOwnerFilter(req, {
              query: 'SELECT VALUE MAX(c.sortOrder) FROM c WHERE c.entityId = @entityId',
              parameters: [{ name: '@entityId', value: add.entityId }],
            }),
            { partitionKey: add.entityId },
          )
          .fetchAll();
        const max = resources[0];
        nextSortOrderByEntity.set(add.entityId, typeof max === 'number' ? max + 1 : 0);
      }
      const sortOrder = nextSortOrderByEntity.get(add.entityId)!;
      nextSortOrderByEntity.set(add.entityId, sortOrder + 1);

      const photo = add.photo && typeof add.photo.url === 'string' && typeof add.photo.thumbnailUrl === 'string'
        ? { url: add.photo.url, thumbnailUrl: add.photo.thumbnailUrl }
        : undefined;
      const event: TimelineEvent = {
        id: randomUUID(),
        entityId: add.entityId,
        seriesId: entity.seriesId,
        name: add.name.trim(),
        timeframe: add.timeframe?.trim() || undefined,
        description: add.description?.trim() || undefined,
        location: add.location?.trim() || undefined,
        locationEntityId: typeof add.locationEntityId === 'string' ? add.locationEntityId : undefined,
        photo,
        sortOrder,
        source: 'chapter',
        chapterId,
        owner: req.user!.email,
        createdBy: req.user!.email,
        createdAt: now,
        modifiedBy: req.user!.email,
        modifiedAt: now,
      };
      try {
        await container.items.create<TimelineEvent>(event);
        added++;
      } catch (createErr) {
        console.error(`apply-chapter-proposals: failed to create event "${add.name}" for entity ${add.entityId}:`, createErr);
      }
    }

    // Updates — only chapter-sourced events belonging to this chapter.
    for (const update of Array.isArray(updates) ? updates : []) {
      if (!update?.eventId || !update?.entityId || !update?.proposed?.name?.trim()) continue;
      const existing = await readOwnedItem<TimelineEvent>(container, update.eventId, update.entityId, req);
      if (!existing || existing.chapterId !== chapterId || existing.source !== 'chapter') continue;
      const replacement: TimelineEvent = {
        ...existing,
        name: update.proposed.name.trim(),
        timeframe: update.proposed.timeframe?.trim() || undefined,
        description: update.proposed.description?.trim() || undefined,
        location: update.proposed.location?.trim() || undefined,
        locationEntityId: typeof update.proposed.locationEntityId === 'string'
          ? update.proposed.locationEntityId
          : undefined,
        modifiedBy: req.user!.email,
        modifiedAt: now,
      };
      try {
        await container.item(existing.id, existing.entityId).replace<TimelineEvent>(replacement);
        updated++;
      } catch (updateErr) {
        console.error(`apply-chapter-proposals: failed to update event ${update.eventId}:`, updateErr);
      }
    }

    // Removes — only chapter-sourced events belonging to this chapter.
    for (const remove of Array.isArray(removes) ? removes : []) {
      if (!remove?.eventId || !remove?.entityId) continue;
      const existing = await readOwnedItem<TimelineEvent>(container, remove.eventId, remove.entityId, req);
      if (!existing || existing.chapterId !== chapterId || existing.source !== 'chapter') continue;
      try {
        await container.item(existing.id, existing.entityId).delete();
        removed++;
      } catch (removeErr) {
        console.error(`apply-chapter-proposals: failed to delete event ${remove.eventId}:`, removeErr);
      }
    }

    res.json({ added, updated, removed });
  } catch (err) {
    console.error('Error applying chapter timeline proposals:', err);
    res.status(500).json({ error: 'Failed to apply timeline proposals' });
  }
});

// ── Place name autocomplete ──────────────────────────────────────────────────

// GET suggest real place names matching a partial query. Used by the location
// autocomplete field in the timeline event dialog. Returns [] on short/empty
// queries rather than hitting the LLM unnecessarily.
router.get('/places/autocomplete', async (req: Request, res: Response) => {
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  if (q.length < 2) {
    res.json({ suggestions: [] });
    return;
  }
  try {
    const completion = await aiClient.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [
        {
          role: 'system',
          content: 'You are a geography assistant. Given partial text, return up to 6 real place names (cities, countries, regions, landmarks) that match or start with that text. Return a JSON object with a "suggestions" key containing an array of strings. Example: {"suggestions": ["London, England", "London, Ontario, Canada"]}. If no good real-place matches exist, return {"suggestions": []}.',
        },
        { role: 'user', content: q },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 200,
    });
    const raw = completion.choices[0]?.message?.content ?? '{"suggestions":[]}';
    let suggestions: string[] = [];
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const arr = parsed['suggestions'] ?? parsed['places'] ?? parsed['results'];
      if (Array.isArray(arr)) {
        suggestions = arr.filter((s): s is string => typeof s === 'string').slice(0, 6);
      }
    } catch {
      suggestions = [];
    }
    res.json({ suggestions });
  } catch (err) {
    console.error('Error getting place suggestions:', err);
    res.json({ suggestions: [] });
  }
});

export default router;
