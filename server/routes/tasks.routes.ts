import { Router, Request, Response } from 'express';
import { getContainer } from '../services/cosmos';
import {
  createTask,
  findFulfilledTasks,
  lastEditedBookId,
  linkTaskBody,
  listTaskBooks,
  matchBookByTitle,
  matchesTaskSearch,
  orderTasks,
  parseSpokenTask,
  queryTasks,
  readTask,
  readTaskInput,
  replaceTask,
  setTaskCompleted,
  summarizeTasks,
  withBookTitles,
} from '../services/tasks';
import { Task, TaskPage, TaskStatusFilter, todayIn } from '../../shared/models/task.model';
import { Chapter } from '../../shared/models/chapter.model';

const router = Router();

function statusParam(value: unknown): TaskStatusFilter {
  return value === 'completed' || value === 'all' ? value : 'open';
}

function intParam(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The caller's IANA time zone from `?tz=` or the body, for "today" and "overdue". */
function tzOf(req: Request): string | undefined {
  const tz = (req.query['tz'] ?? req.body?.tz) as unknown;
  return typeof tz === 'string' && tz ? tz : undefined;
}

const MAX_PAGE = 500;

// GET / — the caller's tasks plus their books.
//   ?status=open|completed|all (default open)  ?bookId=  ?q=words  ?offset=  ?limit=
router.get('/', async (req: Request, res: Response) => {
  try {
    const owner = req.user!.email;
    const bookId = typeof req.query['bookId'] === 'string' && req.query['bookId'] ? String(req.query['bookId']) : undefined;
    const q = String(req.query['q'] ?? '');
    const offset = intParam(req.query['offset'], 0);
    const limit = Math.min(Math.max(intParam(req.query['limit'], 100), 1), MAX_PAGE);
    const [tasks, books] = await Promise.all([queryTasks(owner, bookId), listTaskBooks(owner)]);
    const matching = orderTasks(tasks, statusParam(req.query['status'])).filter(t => matchesTaskSearch(t, q));
    const page: TaskPage = {
      items: withBookTitles(matching.slice(offset, offset + limit), books),
      total: matching.length,
      books,
      lastEditedBookId: await lastEditedBookId(owner, books),
    };
    res.json(page);
  } catch (err) {
    console.error('Error fetching tasks:', err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// GET /summary — counts and the most pressing open tasks (home tile, Siri). ?tz=
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const owner = req.user!.email;
    const [tasks, books] = await Promise.all([queryTasks(owner), listTaskBooks(owner)]);
    res.json(summarizeTasks(tasks, books, todayIn(tzOf(req)), Math.min(intParam(req.query['limit'], 5), 20)));
  } catch (err) {
    console.error('Error summarizing tasks:', err);
    res.status(500).json({ error: 'Failed to summarize tasks' });
  }
});

// POST /check-chapter — which open tasks might this chapter save have finished?
// Body: { chapterId, previousContent, content, excludeTaskIds? }. Response: { candidates }.
router.post('/check-chapter', async (req: Request, res: Response) => {
  const { chapterId, previousContent, content, excludeTaskIds } = req.body ?? {};
  if (typeof chapterId !== 'string' || typeof content !== 'string' || typeof previousContent !== 'string') {
    res.status(400).json({ error: 'chapterId, previousContent and content are required' });
    return;
  }
  try {
    const { resource: chapter } = await getContainer('chapters').item(chapterId, chapterId).read<Chapter>();
    if (!chapter?.bookId) {
      res.json({ candidates: [] });
      return;
    }
    const candidates = await findFulfilledTasks(
      req.user!,
      { id: chapter.id, bookId: chapter.bookId, title: chapter.title },
      previousContent,
      content,
      Array.isArray(excludeTaskIds) ? excludeTaskIds.filter((x: unknown): x is string => typeof x === 'string') : [],
    );
    res.json({ candidates });
  } catch (err) {
    if ((err as { code?: number }).code === 404) {
      res.json({ candidates: [] });
      return;
    }
    console.error('Error checking chapter against tasks:', err);
    res.status(500).json({ error: 'Failed to check tasks' });
  }
});

// POST /voice — a task dictated to Siri. Body: { text, bookName?, tz? }.
// Response: { saved: true, task, spoken } or { saved: false, needsBook: true, books: string[], spoken }.
router.post('/voice', async (req: Request, res: Response) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  if (text.length > 2000) {
    res.status(400).json({ error: 'text is too long' });
    return;
  }
  try {
    const owner = req.user!.email;
    const books = await listTaskBooks(owner);
    if (!books.length) {
      res.json({ saved: false, needsBook: false, books: [], spoken: 'You don\'t have any books yet. Create one in Quill first.' });
      return;
    }
    const parsed = await parseSpokenTask(req.user, text, books, todayIn(tzOf(req)));
    if (!parsed) {
      res.status(502).json({ error: 'Quill couldn\'t understand that task. Try saying it again.' });
      return;
    }
    const named = typeof req.body?.bookName === 'string' ? matchBookByTitle(books, req.body.bookName) : null;
    // No book named: assume the one the author last edited.
    const recentId = named || parsed.bookId ? null : await lastEditedBookId(owner, books);
    const book =
      named ??
      books.find(b => b.id === parsed.bookId) ??
      books.find(b => b.id === recentId) ??
      (books.length === 1 ? books[0] : undefined);
    if (!book) {
      res.json({
        saved: false,
        needsBook: true,
        books: books.map(b => b.title),
        spoken: 'Which book is it for?',
      });
      return;
    }
    const task = await createTask(req.user!, { title: parsed.title, body: parsed.body, book, dueDate: parsed.dueDate });
    const due = task.dueDate
      ? `, due ${new Date(`${task.dueDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })}`
      : '';
    res.json({ saved: true, task, spoken: `Added "${task.title}" to ${book.title}${due}.` });
  } catch (err) {
    console.error('Error saving spoken task:', err);
    res.status(500).json({ error: 'Failed to save the task' });
  }
});

// GET /:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const owner = req.user!.email;
    const task = await readTask(owner, req.params['id'] as string);
    if (!task || task.deleted) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    const books = await listTaskBooks(owner);
    res.json(withBookTitles([task], books)[0]);
  } catch (err) {
    console.error('Error fetching task:', err);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// POST / — create. Body: { title, body?, bookId, dueDate? }
router.post('/', async (req: Request, res: Response) => {
  try {
    const owner = req.user!.email;
    const books = await listTaskBooks(owner);
    const input = readTaskInput(req.body ?? {}, books);
    if (!input.ok) {
      res.status(400).json({ error: input.error });
      return;
    }
    const task = await createTask(req.user!, input);
    res.status(201).json(withBookTitles([task], books)[0]);
  } catch (err) {
    console.error('Error creating task:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// PUT /:id — update title, body, book, due date. The body is relinked when it or the book changes.
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const owner = req.user!.email;
    const existing = await readTask(owner, req.params['id'] as string);
    if (!existing || existing.deleted) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    const books = await listTaskBooks(owner);
    const input = readTaskInput(req.body ?? {}, books, existing);
    if (!input.ok) {
      res.status(400).json({ error: input.error });
      return;
    }
    const relink = input.body !== existing.body || input.book.id !== existing.bookId || req.body?.relink === true;
    const updated: Task = {
      ...existing,
      title: input.title,
      bookId: input.book.id,
      seriesId: input.book.seriesId,
      modifiedBy: owner,
      modifiedAt: new Date().toISOString(),
      links: relink ? await linkTaskBody(req.user!, input.body, input.book) : existing.links,
    };
    if (input.body) updated.body = input.body;
    else delete updated.body;
    if (input.dueDate) updated.dueDate = input.dueDate;
    else delete updated.dueDate;
    res.json(withBookTitles([await replaceTask(updated)], books)[0]);
  } catch (err) {
    console.error('Error updating task:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// PATCH /:id/complete — Body: { completed?: boolean (default true), chapterId? }
router.patch('/:id/complete', async (req: Request, res: Response) => {
  try {
    const owner = req.user!.email;
    const existing = await readTask(owner, req.params['id'] as string);
    if (!existing || existing.deleted) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    const completed = req.body?.completed !== false;
    const chapterId = typeof req.body?.chapterId === 'string' ? req.body.chapterId : undefined;
    res.json(await setTaskCompleted(owner, existing, completed, chapterId));
  } catch (err) {
    console.error('Error completing task:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// PATCH /:id/restore — undo a delete
router.patch('/:id/restore', async (req: Request, res: Response) => {
  try {
    const owner = req.user!.email;
    const existing = await readTask(owner, req.params['id'] as string);
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(await replaceTask({ ...existing, deleted: false, modifiedBy: owner, modifiedAt: new Date().toISOString() }));
  } catch (err) {
    console.error('Error restoring task:', err);
    res.status(500).json({ error: 'Failed to restore task' });
  }
});

// DELETE /:id — soft delete
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const owner = req.user!.email;
    const existing = await readTask(owner, req.params['id'] as string);
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    await replaceTask({ ...existing, deleted: true, modifiedBy: owner, modifiedAt: new Date().toISOString() });
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting task:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

export default router;
