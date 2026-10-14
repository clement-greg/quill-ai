import express, { Request, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';

const CLIENT_BUILD = path.join('client', 'dist', 'client', 'browser');

/**
 * Locates the Angular build. The server runs from two depths: compiled
 * (dist/server/index.js — production, the desktop app) and from source under
 * ts-node (server/index.ts — `npm run dev`). A fixed `../../client/...` only
 * resolved for the compiled layout, so in development port 3200 served an
 * ENOENT error page instead of the app.
 */
export function findClientDir(serverDir: string): string | null {
  const candidates = [
    path.join(serverDir, '..', '..', CLIENT_BUILD), // dist/server
    path.join(serverDir, '..', CLIENT_BUILD), // server (ts-node)
  ];
  return candidates.find(dir => fs.existsSync(path.join(dir, 'index.html'))) ?? null;
}

const NOT_BUILT_MESSAGE =
  'The Quill AI web client has not been built.\n\n' +
  'In development, open the Angular dev server at http://localhost:6258 (npm run dev),\n' +
  'or build the client with `npm run build` to serve it from this port.\n';

/**
 * Angular's build names its JS, CSS and fonts with a content hash
 * (main-XWFOQL5H.js, media/material-symbols-outlined-HKY7TYOV.woff2), so a
 * changed file always gets a new URL and these can be cached forever. Without
 * this every page load revalidated the ~4 MB icon font with the server.
 */
const HASHED_ASSET = /-[A-Z0-9]{8}\.(js|css|woff2?|ttf|otf)$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** index.html names the current hashed files, so it must always be fresh. */
const NO_CACHE = 'no-cache';

function setCacheHeaders(res: Response, filePath: string): void {
  if (HASHED_ASSET.test(filePath)) res.setHeader('Cache-Control', IMMUTABLE);
  else if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', NO_CACHE);
}

/** Serves the Angular build, falling back to index.html for client-side routes. */
export function clientRoutes(clientDir: string | null): Router {
  const router = Router();
  if (!clientDir) {
    router.get('*path', (_req: Request, res: Response) => {
      res.status(503).type('text/plain').send(NOT_BUILT_MESSAGE);
    });
    return router;
  }
  router.use(express.static(clientDir, { setHeaders: setCacheHeaders }));
  router.get('*path', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', NO_CACHE);
    res.sendFile(path.join(clientDir, 'index.html'));
  });
  return router;
}
