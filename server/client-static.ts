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

/** Serves the Angular build, falling back to index.html for client-side routes. */
export function clientRoutes(clientDir: string | null): Router {
  const router = Router();
  if (!clientDir) {
    router.get('*path', (_req: Request, res: Response) => {
      res.status(503).type('text/plain').send(NOT_BUILT_MESSAGE);
    });
    return router;
  }
  router.use(express.static(clientDir));
  router.get('*path', (_req: Request, res: Response) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });
  return router;
}
