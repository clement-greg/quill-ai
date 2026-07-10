import { Router, Request, Response } from 'express';
import { AzureOpenAI } from 'openai';
import config from '../config';
import { getContainer } from '../services/cosmos';
import { Series } from '../../shared/models/series.model';
import { readOwnedItem, readAccessibleItem } from '../middleware/owner-guard';

const aiClient = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

const router = Router();
const container = getContainer('series');

// GET all series (owned and shared with the current user)
router.get('/', async (req: Request, res: Response) => {
  try {
    const email = req.user!.email;
    const { resources } = await container.items
      .query({
        query: 'SELECT * FROM c WHERE (c.owner = @owner OR ARRAY_CONTAINS(c.collaborators, @email)) AND (NOT IS_DEFINED(c.archived) OR c.archived = false)',
        parameters: [
          { name: '@owner', value: email },
          { name: '@email', value: email },
        ],
      })
      .fetchAll();
    res.json(resources as Series[]);
  } catch (err) {
    console.error('Error fetching series:', err);
    res.status(500).json({ error: 'Failed to fetch series' });
  }
});

// GET all archived series (owned only)
router.get('/archived', async (req: Request, res: Response) => {
  try {
    const email = req.user!.email;
    const { resources } = await container.items
      .query({
        query: 'SELECT * FROM c WHERE c.owner = @owner AND c.archived = true AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)',
        parameters: [{ name: '@owner', value: email }],
      })
      .fetchAll();
    res.json(resources as Series[]);
  } catch (err) {
    console.error('Error fetching archived series:', err);
    res.status(500).json({ error: 'Failed to fetch archived series' });
  }
});

// GET single series by id (owner or collaborator)
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const resource = await readAccessibleItem<Series>(container, id, id, req);
    if (!resource) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    res.json(resource);
  } catch (err) {
    console.error('Error fetching series:', err);
    res.status(500).json({ error: 'Failed to fetch series' });
  }
});

// POST create new series
router.post('/', async (req: Request, res: Response) => {
  try {
    const series: Series = req.body;
    if (!series.title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }
    const now = new Date().toISOString();
    series.owner = series.owner || req.user!.email;
    series.createdBy = req.user!.email;
    series.createdAt = now;
    series.modifiedBy = req.user!.email;
    series.modifiedAt = now;
    const { resource } = await container.items.create<Series>(series);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error creating series:', err);
    res.status(500).json({ error: 'Failed to create series' });
  }
});

// PUT update series
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const series: Series = { ...req.body, id, owner: req.body.owner || req.user!.email, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Series>(series);
    res.json(resource);
  } catch (err) {
    console.error('Error updating series:', err);
    res.status(500).json({ error: 'Failed to update series' });
  }
});

// PATCH archive series
router.patch('/:id/archive', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<Series>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const updated: Series = { ...existing, archived: true, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Series>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error archiving series:', err);
    res.status(500).json({ error: 'Failed to archive series' });
  }
});

// PATCH unarchive series
router.patch('/:id/unarchive', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<Series>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const updated: Series = { ...existing, archived: false, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Series>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error unarchiving series:', err);
    res.status(500).json({ error: 'Failed to unarchive series' });
  }
});

// PATCH soft-delete series
router.patch('/:id/soft-delete', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<Series>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const updated: Series = { ...existing, deleted: true, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Series>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error soft-deleting series:', err);
    res.status(500).json({ error: 'Failed to soft-delete series' });
  }
});

// PATCH restore soft-deleted series
router.patch('/:id/restore-delete', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<Series>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const updated: Series = { ...existing, deleted: false, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Series>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error restoring series:', err);
    res.status(500).json({ error: 'Failed to restore series' });
  }
});

// DELETE series
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    await container.item(id, id).delete();
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting series:', err);
    res.status(500).json({ error: 'Failed to delete series' });
  }
});

// POST add a collaborator to a series (owner only)
router.post('/:id/collaborators', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const resource = await readOwnedItem<Series>(container, id, id, req);
    if (!resource) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const { email } = req.body as { email?: string };
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      res.status(400).json({ error: 'Invalid email format' });
      return;
    }
    if (email === resource.owner) {
      res.status(400).json({ error: 'Owner cannot be added as a collaborator' });
      return;
    }
    const collaborators = [...(resource.collaborators ?? [])];
    if (!collaborators.includes(email)) {
      collaborators.push(email);
    }
    const updated: Series = { ...resource, collaborators, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource: saved } = await container.item(id, id).replace<Series>(updated);
    res.json(saved);
  } catch (err) {
    console.error('Error adding collaborator:', err);
    res.status(500).json({ error: 'Failed to add collaborator' });
  }
});

// DELETE remove a collaborator from a series (owner only)
router.delete('/:id/collaborators/:email', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const emailToRemove = decodeURIComponent(req.params['email'] as string);
    const resource = await readOwnedItem<Series>(container, id, id, req);
    if (!resource) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const collaborators = (resource.collaborators ?? []).filter(e => e !== emailToRemove);
    const updated: Series = { ...resource, collaborators, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource: saved } = await container.item(id, id).replace<Series>(updated);
    res.json(saved);
  } catch (err) {
    console.error('Error removing collaborator:', err);
    res.status(500).json({ error: 'Failed to remove collaborator' });
  }
});

// POST generate a robust system prompt from basic series info
router.post('/:id/generate-system-prompt', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const basicPrompt: string = req.body.basicPrompt ?? '';

    const resource = await readOwnedItem<Series>(container, id, id, req);
    if (!resource) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const seriesTitle = resource.title ?? 'this series';

    const metaPrompt =
      `You are an expert prompt engineer. A user is writing a story series titled "${seriesTitle}". ` +
      `Based on the following basic description, create a comprehensive, detailed system prompt that will guide an AI writing assistant ` +
      `to produce consistent, high-quality responses for this series. ` +
      `The system prompt should cover tone, style, setting, characters, themes, and any important rules or constraints. ` +
      `Return only the system prompt text — no explanations, no preamble.\n\n` +
      `Basic description: ${basicPrompt}`;

    const completion = await aiClient.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [{ role: 'user', content: metaPrompt }],
    });

    const systemPrompt = completion.choices[0]?.message?.content?.trim() ?? '';
    res.json({ systemPrompt });
  } catch (err) {
    console.error('Error generating system prompt:', err);
    res.status(500).json({ error: 'Failed to generate system prompt' });
  }
});

export default router;
