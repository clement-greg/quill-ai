import express, { Router } from 'express';

export const USER_A = 'alice@example.com';
export const USER_B = 'bob@example.com';
export const COLLABORATOR = 'carol@example.com';

/**
 * Wraps a router in a minimal Express app for supertest, with the auth
 * middleware replaced by one that trusts an `x-test-user` header — so a test
 * can act as any user with `.set('x-test-user', USER_B)`.
 */
export function makeTestApp(basePath: string, router: Router): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const email = (req.headers['x-test-user'] as string) || USER_A;
    req.user = { email, sub: `sub-${email}` };
    next();
  });
  app.use(basePath, router);
  return app;
}
