/**
 * Chat tools for tasks: create, find, and complete. Used by the series chat,
 * the quick-chat overlay, and the Siri /voice endpoint.
 */
import { Request } from 'express';
import {
  createTask,
  listTaskBooks,
  matchBookByTitle,
  matchesTaskSearch,
  orderTasks,
  queryTasks,
  readTask,
  setTaskCompleted,
} from '../services/tasks';
import { MAX_TASK_TITLE_LENGTH, Task, TaskBookOption, addDays, normalizeDueDate, todayIn } from '../../shared/models/task.model';

/** Same shape as the ChatTool the chat routes run. */
export interface TaskChatTool {
  definition: unknown;
  successLottie?: string;
  execute: (args: Record<string, unknown>) => Promise<{ toolResult: unknown; sse?: object; success?: boolean }>;
}

export interface TaskChatContext {
  /** Book to file a task under when the author doesn't name one (e.g. the chapter being edited). */
  defaultBookId?: string;
  /** Series in scope (series chat): its only book is used when no book is named. */
  seriesId?: string;
}

/** The caller's time zone, sent by the client as `tz` in the request body. */
export function requestTimeZone(req: Request): string | undefined {
  const tz = req.body?.tz;
  return typeof tz === 'string' && tz ? tz : undefined;
}

export function taskGuidance(req: Request): string {
  const today = todayIn(requestTimeZone(req));
  const weekday = new Date(`${today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return (
    '\n\nTASKS: The author keeps a to-do list of tasks, each filed under one of their books with an optional ' +
    `due date. Today is ${weekday}, ${today}. When they ask you to add a task, to-do, or reminder for a book ` +
    '(or use the /task command), call create_task: a short imperative "title", any further detail in "body" ' +
    'in their words (mention characters and chapters by name — they get linked automatically), "bookName" ' +
    'when they name a book, and "dueDate" as YYYY-MM-DD resolved against today when they give a date ' +
    '("Friday" is the coming Friday). If the tool says it needs a book, ask which one. When they ask what ' +
    'tasks they have, what is due or overdue, or about a particular task, call find_tasks and show each as a ' +
    'markdown link using its "link" exactly, with its book and due date. When they say they finished or did ' +
    'a task, call find_tasks to identify it if needed, then complete_task with its "id"; if several could ' +
    'match, ask which. Never invent a task or a link. Tasks are separate from Thoughts: use save_thought only ' +
    'for ideas and notes that are not to-dos.'
  );
}

function bookChoices(books: TaskBookOption[]): string {
  return books.map(b => `"${b.title}"`).join(', ');
}

function taskView(t: Task, books: TaskBookOption[], today: string) {
  return {
    id: t.id,
    title: t.title,
    body: t.body ? (t.body.length > 300 ? `${t.body.slice(0, 300)}…` : t.body) : null,
    book: books.find(b => b.id === t.bookId)?.title ?? null,
    dueDate: t.dueDate ?? null,
    overdue: !t.completed && !!t.dueDate && t.dueDate < today,
    completed: t.completed,
    completedAt: t.completedAt ?? null,
    link: `/tasks?open=${encodeURIComponent(t.id)}`,
  };
}

function getCreateTaskTool(req: Request, ctx: TaskChatContext): TaskChatTool {
  return {
    successLottie: 'https://lottie.host/883c202e-9be4-4254-9dba-3fdc86a4ac69/7iuM3NQkyu.json',
    definition: {
      type: 'function',
      function: {
        name: 'create_task',
        description:
          'Add a task (to-do) for one of the author\'s books, optionally with a due date. Entity and chapter ' +
          'names in the body are linked automatically.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short imperative summary, e.g. "Foreshadow the flood in chapter 2".' },
            body: { type: 'string', description: 'Optional further detail, in the author\'s words.' },
            bookName: { type: 'string', description: 'Title (or part of it) of the book the task is for, when the author names one.' },
            dueDate: { type: 'string', description: 'Due date as YYYY-MM-DD, resolved against today. Omit when none was given.' },
          },
          required: ['title'],
        },
      },
    },
    execute: async args => {
      const title = String(args['title'] ?? '').trim().slice(0, MAX_TASK_TITLE_LENGTH);
      if (!title) return { toolResult: { saved: false, message: 'No task was given. Ask the author what the task is.' } };
      const owner = req.user!.email;
      const books = await listTaskBooks(owner);
      if (!books.length) {
        return { toolResult: { saved: false, message: 'The author has no books yet; a task must belong to a book.' } };
      }
      const bookName = String(args['bookName'] ?? '').trim();
      let book: TaskBookOption | null | undefined = bookName ? matchBookByTitle(books, bookName) : undefined;
      if (bookName && !book) {
        return { toolResult: { saved: false, needsBook: true, message: `No book matches "${bookName}". Their books: ${bookChoices(books)}. Ask which one.` } };
      }
      if (!book && ctx.defaultBookId) book = books.find(b => b.id === ctx.defaultBookId);
      if (!book && ctx.seriesId) {
        const inSeries = books.filter(b => b.seriesId === ctx.seriesId);
        if (inSeries.length === 1) book = inSeries[0];
      }
      if (!book && books.length === 1) book = books[0];
      if (!book) {
        return { toolResult: { saved: false, needsBook: true, message: `Which book is this task for? Their books: ${bookChoices(books)}.` } };
      }
      const rawDue = String(args['dueDate'] ?? '').trim();
      const dueDate = rawDue ? normalizeDueDate(rawDue) : undefined;
      try {
        const body = String(args['body'] ?? '').trim() || undefined;
        const task = await createTask(req.user!, { title, body, book, dueDate });
        console.log('[create_task] owner="%s" book="%s" due=%s', owner, book.title, dueDate ?? '-');
        return {
          toolResult: {
            saved: true,
            task: taskView(task, books, todayIn(requestTimeZone(req))),
            message: `Task added to ${book.title}. Confirm briefly, linking it with "link".` +
              (rawDue && !dueDate ? ' The due date was not a valid date and was left off; tell the author.' : ''),
          },
          success: true,
        };
      } catch (err) {
        console.error('create_task error:', err);
        return { toolResult: { saved: false, message: 'Saving the task failed. Apologize briefly and suggest trying again.' } };
      }
    },
  };
}

function getFindTasksTool(req: Request): TaskChatTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'find_tasks',
        description:
          'List or search the author\'s tasks. Open tasks come back most urgent first (overdue, then soonest due).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Words in the task\'s title or body. Omit to list all.' },
            bookName: { type: 'string', description: 'Only tasks for this book.' },
            status: { type: 'string', enum: ['open', 'completed', 'all'], description: 'Default open.' },
            dueWithinDays: { type: 'number', description: 'Only open tasks due within this many days from today (overdue included).' },
          },
        },
      },
    },
    execute: async args => {
      try {
        const owner = req.user!.email;
        const today = todayIn(requestTimeZone(req));
        const books = await listTaskBooks(owner);
        const bookName = String(args['bookName'] ?? '').trim();
        const book = bookName ? matchBookByTitle(books, bookName) : null;
        if (bookName && !book) {
          return { toolResult: { found: false, message: `No book matches "${bookName}". Their books: ${bookChoices(books)}.` } };
        }
        const status = args['status'] === 'completed' || args['status'] === 'all' ? args['status'] : 'open';
        let tasks = orderTasks(await queryTasks(owner, book?.id), status).filter(t => matchesTaskSearch(t, String(args['query'] ?? '')));
        const within = Number(args['dueWithinDays']);
        if (Number.isFinite(within) && within >= 0) {
          const end = addDays(today, Math.floor(within));
          tasks = tasks.filter(t => !t.completed && t.dueDate && t.dueDate <= end);
        }
        if (!tasks.length) return { toolResult: { found: false, message: 'No tasks matched.' } };
        return {
          toolResult: {
            found: true,
            total: tasks.length,
            tasks: tasks.slice(0, 15).map(t => taskView(t, books, today)),
          },
        };
      } catch (err) {
        console.error('find_tasks error:', err);
        return { toolResult: { found: false, message: 'Looking up tasks failed. Apologize briefly.' } };
      }
    },
  };
}

function getCompleteTaskTool(req: Request): TaskChatTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'complete_task',
        description: 'Mark one of the author\'s tasks done (or reopen it). Get the id from find_tasks.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The task id from find_tasks.' },
            reopen: { type: 'boolean', description: 'True to mark a completed task open again.' },
          },
          required: ['id'],
        },
      },
    },
    execute: async args => {
      try {
        const owner = req.user!.email;
        const task = await readTask(owner, String(args['id'] ?? ''));
        if (!task || task.deleted) {
          return { toolResult: { done: false, message: 'No task has that id. Call find_tasks to get the right one.' } };
        }
        const updated = await setTaskCompleted(owner, task, args['reopen'] !== true);
        return {
          toolResult: { done: true, task: { title: updated.title, completed: updated.completed } },
          success: true,
        };
      } catch (err) {
        console.error('complete_task error:', err);
        return { toolResult: { done: false, message: 'Updating the task failed. Apologize briefly.' } };
      }
    },
  };
}

export function taskChatTools(req: Request, ctx: TaskChatContext = {}): Record<string, TaskChatTool> {
  return {
    create_task: getCreateTaskTool(req, ctx),
    find_tasks: getFindTasksTool(req),
    complete_task: getCompleteTaskTool(req),
  };
}
