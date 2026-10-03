import { HttpErrorResponse } from '@angular/common/http';
import { TimeoutError } from 'rxjs';

/**
 * What to tell the user about a generation request that failed, and whether
 * sending the same job again is worth offering. The server names the cause in
 * `{ error }` for everything it recognises — including the receiver's own
 * message, so a stopped ComfyUI or an offline tunnel says so here rather than
 * reading as a generic failure.
 */
export function generationFailure(err: unknown): { reason: string; retryable: boolean } {
  if (err instanceof TimeoutError) {
    return { reason: 'the request took too long and was given up on', retryable: true };
  }
  if (!(err instanceof HttpErrorResponse)) {
    return { reason: 'something went wrong sending the request', retryable: true };
  }
  // Status 0 never reached our own server — the phone lost its connection, or
  // the dev server is down. There is no body to read a reason from.
  if (err.status === 0) {
    return { reason: 'no connection to Quill — check your network', retryable: true };
  }

  const reason = typeof err.error?.error === 'string' && err.error.error.trim()
    ? err.error.error.trim()
    : `server returned ${err.status}`;

  // 4xx is this request being wrong (bad prompt, bad photo) — sending the
  // identical job again would fail the same way. 5xx is the far side or the
  // link between, which is exactly what is expected to be flaky.
  const retryable = err.status >= 500 || err.status === 429;
  return { reason, retryable };
}
