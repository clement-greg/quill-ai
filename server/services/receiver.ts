import config from '../config';

/**
 * The external generation receiver (receiver/server.py), reached over a dev
 * tunnel. Shared by the relay routes and the generation collector so both talk
 * to it the same way.
 */

/**
 * Dev tunnels answer an unrecognised client with an interstitial page instead of
 * forwarding the request; this header opts out of it. Every receiver call needs it.
 */
export const RECEIVER_HEADERS = { 'X-Tunnel-Skip-AntiPhishing-Page': 'true' };

/** True when a receiver is configured at all. */
export function hasReceiver(): boolean {
  return !!config.photoExportUrl?.trim();
}

/** A url on the receiver, or null when none is configured. */
export function receiverUrl(path: string, query?: Record<string, string>): string | null {
  const base = config.photoExportUrl?.trim().replace(/\/+$/, '');
  if (!base) return null;
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  return `${base}${path}${search}`;
}

/**
 * The reason the receiver gave, when it sent one, for showing in the UI.
 * `Response` here is fetch's, not Express's — hence the explicit global.
 */
export async function receiverError(response: globalThis.Response): Promise<string> {
  const body = (await response.text().catch(() => '')).slice(0, 2000);
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // Not JSON — an HTML error page or a proxy's own message.
  }
  return `Receiver returned ${response.status}`;
}
