import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import config from '../config';

const router = Router();
const googleClient = new OAuth2Client(config.googleClientId);

// Short-lived access token sent on every API request; long-lived refresh token
// used only to mint new access tokens. The refresh token is rotated on each use
// (see /refresh), so an active user's session slides forward indefinitely.
const ACCESS_TOKEN_EXPIRY = '1h';
const REFRESH_TOKEN_EXPIRY = '30d';

interface UserClaims {
  email: string;
  sub?: string;
  name?: string;
  picture?: string;
}

function signAccessToken(user: UserClaims): string {
  return jwt.sign({ ...user, type: 'access' }, config.jwtSecret, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

function signRefreshToken(user: UserClaims): string {
  return jwt.sign({ ...user, type: 'refresh' }, config.jwtSecret, { expiresIn: REFRESH_TOKEN_EXPIRY });
}

// POST /api/auth/login
// Accepts a Google ID token, verifies it, and returns an access + refresh token pair.
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { credential } = req.body as { credential?: string };
  if (!credential) {
    res.status(400).json({ error: 'Missing credential' });
    return;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: config.googleClientId,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      res.status(401).json({ error: 'Invalid token payload' });
      return;
    }

    const claims: UserClaims = {
      email: payload.email,
      sub: payload.sub,
      name: payload.name,
      picture: payload.picture,
    };

    res.json({ token: signAccessToken(claims), refreshToken: signRefreshToken(claims) });
  } catch (err) {
    console.error('[auth/login] verifyIdToken failed:', err);
    res.status(401).json({ error: 'Invalid Google credential' });
  }
});

// POST /api/auth/refresh
// Exchanges a valid (non-expired) refresh token for a fresh access + refresh
// token pair. Rotating the refresh token here gives the session a sliding
// expiry: a user active within any 30-day window never has to sign in again.
router.post('/refresh', (req: Request, res: Response): void => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) {
    res.status(400).json({ error: 'Missing refresh token' });
    return;
  }

  try {
    const payload = jwt.verify(refreshToken, config.jwtSecret) as jwt.JwtPayload;
    if (payload['type'] !== 'refresh' || !payload['email']) {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    const claims: UserClaims = {
      email: payload['email'] as string,
      sub: payload['sub'] as string | undefined,
      name: payload['name'] as string | undefined,
      picture: payload['picture'] as string | undefined,
    };

    res.json({ token: signAccessToken(claims), refreshToken: signRefreshToken(claims) });
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

export default router;
