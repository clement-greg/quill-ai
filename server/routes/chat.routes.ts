import { Router, Request, Response } from 'express';
import { AzureOpenAI } from 'openai';
import config from '../config';
import { getContainer } from '../services/cosmos';
import { Entity } from '../../shared/models/entity.model';
import { buildChapterContextPrompt } from '../services/chapter-ai-context';

const router = Router();

const client = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

// POST /general — generic inline AI assist (for notes, etc.) with optional series context
router.post('/general', async (req: Request, res: Response) => {
  const { messages, seriesId, selectedText } = req.body as {
    messages: { role: 'user' | 'assistant'; content: string }[];
    seriesId?: string;
    selectedText?: string;
  };

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  let systemPrompt =
    'You are a helpful writing assistant. Provide only the requested content in plain text. ' +
    'Do not use markdown, HTML, or any formatting. Do not include conversational filler or meta-commentary.';

  if (seriesId) {
    try {
      const entitiesContainer = getContainer('entities');
      const { resources } = await entitiesContainer.items
        .query<Entity>({
          query: 'SELECT c.name, c.type, c.biography FROM c WHERE c.seriesId = @seriesId AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)',
          parameters: [{ name: '@seriesId', value: seriesId }],
        })
        .fetchAll();
      if (resources.length > 0) {
        const entitySummary = resources
          .map(e => `${e.name} (${e.type})${e.biography ? ': ' + e.biography.slice(0, 80) : ''}`)
          .join('\n');
        systemPrompt += `\n\nWorld context — known entities:\n${entitySummary}`;
      }
    } catch {
      // Proceed without entity context
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stream = await client.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      max_tokens: 2048,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('General chat streaming error:', err);
    const isContentFilter = (err as { code?: string })?.code === 'content_filter';
    const errorMessage = isContentFilter
      ? 'Your request was blocked by the content filter. Try rephrasing.'
      : 'AI error occurred';
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
  } finally {
    res.end();
  }
});

// GET chat history for a chapter (returns empty if soft-deleted or not owned)
router.get('/:chapterId/history', async (req: Request, res: Response) => {
  const chapterId = req.params['chapterId'] as string;
  try {
    const container = getContainer('chat-history');
    const { resource } = await container.item(chapterId, chapterId).read<{ id: string; owner?: string; deleted?: boolean; messages: { role: string; text: string; imageUrl?: string }[] }>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.json({ messages: [] });
      return;
    }
    res.json({ messages: resource.messages });
  } catch {
    res.json({ messages: [] });
  }
});

// PUT (upsert) chat history for a chapter
router.put('/:chapterId/history', async (req: Request, res: Response) => {
  const chapterId = req.params['chapterId'] as string;
  const messages: { role: string; text: string; imageUrl?: string }[] = req.body.messages;
  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }
  try {
    const container = getContainer('chat-history');
    await container.items.upsert({ id: chapterId, owner: req.user!.email, messages, deleted: false });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving chat history:', err);
    res.status(500).json({ error: 'Failed to save chat history' });
  }
});

// DELETE chat history for a chapter (soft delete — sets deleted: true)
router.delete('/:chapterId/history', async (req: Request, res: Response) => {
  const chapterId = req.params['chapterId'] as string;
  try {
    const container = getContainer('chat-history');
    await container.items.upsert({ id: chapterId, owner: req.user!.email, messages: [], deleted: true, deletedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error soft-deleting chat history:', err);
    res.status(500).json({ error: 'Failed to clear chat history' });
  }
});

router.post('/:chapterId', async (req: Request, res: Response) => {
  const chapterId = req.params['chapterId'] as string;
  const messages: { role: 'user' | 'assistant'; content: string }[] = req.body.messages;
  const selectedText: string | undefined = req.body.selectedText;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  // Fetch chapter for context
  const genericPrompt = 'You are a helpful writing assistant helping an author with their story. Provide only the requested content in plain text. Do not use markdown, HTML, or any formatting. Do not include conversational filler, preamble, or meta-commentary such as "Sure, here you go" or "Let me generate that for you."';
  let systemPrompt = genericPrompt;

  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  const instructionText = messages[messages.length - 1]?.content ?? '';
  const retrievalQuery = [selectedText, lastUserMessage?.content].filter(Boolean).join('\n\n').trim();
  const { chapterTitle, contextSuffix } = await buildChapterContextPrompt(
    chapterId,
    { selectedText, retrievalQuery, instructionText },
    req,
  );

  if (chapterTitle) {
    const basePrompt = `You are a helpful writing assistant helping an author with their story chapter titled "${chapterTitle}". Provide only the requested content in plain text. Do not use markdown, HTML, or any formatting. Do not include conversational filler, preamble, or meta-commentary such as "Sure, here you go" or "Let me generate that for you."`;
    systemPrompt = basePrompt + contextSuffix;

    // If rewording with no instructions, inject a default reword directive so the
    // model rewords in the character's voice (the speaker context lives in contextSuffix).
    if (selectedText && contextSuffix.includes('is spoken by the character')) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.role === 'user' && lastMessage.content.trim() === `Selected text:\n"${selectedText}"`) {
        lastMessage.content += '\n\nReword this text in the character\'s authentic voice. Return only the reworded text, no explanation.';
      }
    }
  } 

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stream = await client.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      max_tokens: 2048,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('Chat streaming error:', err);
    const isContentFilter = (err as { code?: string })?.code === 'content_filter';
    const errorMessage = isContentFilter
      ? 'Your request was blocked by the content filter. Try rephrasing.'
      : 'AI error occurred';
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
  } finally {
    res.end();
  }
});

export default router;
