import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';

export interface AuthenticatedUser {
  email: string;
  sub: string;  // Google's unique user ID
  name?: string;
  picture?: string;
}

// Extend the Express Request type to carry the verified user
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (!payload || !payload['email']) {
      res.status(401).json({ error: 'Invalid token payload' });
      return;
    }
    // A refresh token must never be accepted as an access token. Legacy tokens
    // issued before the access/refresh split carry no `type` and stay valid.
    if (payload['type'] === 'refresh') {
      res.status(401).json({ error: 'Invalid token type' });
      return;
    }
    req.user = {
      email: payload['email'] as string,
      sub: payload['sub'] as string,
      name: payload['name'] as string | undefined,
      picture: payload['picture'] as string | undefined,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
