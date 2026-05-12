import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth.middleware';

const JWT_SECRET = 'test-secret';

function makeToken(payload: Record<string, unknown>, secret = JWT_SECRET): string {
  return jwt.sign(payload, secret);
}

function makeReq(authHeader?: string): Request {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as Request;
}

function makeRes(): { res: Response; ctx: { statusCode: number | undefined; body: unknown } } {
  const ctx = { statusCode: undefined as number | undefined, body: undefined as unknown };
  const res = {
    status(code: number) {
      ctx.statusCode = code;
      return res;
    },
    json(data: unknown) {
      ctx.body = data;
      return res;
    },
  } as unknown as Response;
  return { res, ctx };
}

describe('requireAuth middleware', () => {
  let next: jest.Mock<NextFunction>;

  beforeEach(() => {
    next = jest.fn();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const req = makeReq();
    const { res, ctx } = makeRes();
    await requireAuth(req, res, next);
    expect(ctx.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header does not start with "Bearer "', async () => {
    const req = makeReq('Basic abc123');
    const { res, ctx } = makeRes();
    await requireAuth(req, res, next);
    expect(ctx.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is signed with a different secret', async () => {
    const token = makeToken({ email: 'user@example.com', sub: '123' }, 'wrong-secret');
    const req = makeReq(`Bearer ${token}`);
    const { res, ctx } = makeRes();
    await requireAuth(req, res, next);
    expect(ctx.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when a valid token is missing the email claim', async () => {
    const token = makeToken({ sub: '123' }); // no email
    const req = makeReq(`Bearer ${token}`);
    const { res, ctx } = makeRes();
    await requireAuth(req, res, next);
    expect(ctx.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the token is expired', async () => {
    const token = makeToken({ email: 'user@example.com', sub: '123', exp: 1 }); // exp in the past
    const req = makeReq(`Bearer ${token}`);
    const { res, ctx } = makeRes();
    await requireAuth(req, res, next);
    expect(ctx.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and sets req.user on a valid token', async () => {
    const token = makeToken({ email: 'user@example.com', sub: 'google-uid-1', name: 'Alice', picture: 'https://example.com/pic.jpg' });
    const req = makeReq(`Bearer ${token}`);
    const { res } = makeRes();
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual(expect.objectContaining({
      email: 'user@example.com',
      sub: 'google-uid-1',
      name: 'Alice',
      picture: 'https://example.com/pic.jpg',
    }));
  });

  it('sets optional fields to undefined when absent from the token', async () => {
    const token = makeToken({ email: 'user@example.com', sub: 'google-uid-2' });
    const req = makeReq(`Bearer ${token}`);
    const { res } = makeRes();
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user?.name).toBeUndefined();
    expect(req.user?.picture).toBeUndefined();
  });
});
