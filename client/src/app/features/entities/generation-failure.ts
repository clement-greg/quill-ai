import { HttpErrorResponse } from '@angular/common/http';
import { MatSnackBar } from '@angular/material/snack-bar';
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

/**
 * Tells the user a generation request failed and copies its prompt to the
 * clipboard, so a long prompt is not lost if they need to send it some other
 * way. By the time this runs the request has already been retried after any
 * 502, so the toast stays until dismissed and offers `retry` when sending the
 * same job again could help.
 */
export function reportGenerationFailure(
  snackBar: MatSnackBar,
  what: string,
  err: unknown,
  prompt: string,
  retry: () => void,
): void {
  const { reason, retryable } = generationFailure(err);
  void copyToClipboard(prompt).then(copied => {
    const note = copied ? ' (prompt copied to clipboard)' : '';
    const toast = snackBar.open(`${what} failed: ${reason}${note}`, retryable ? 'Retry' : 'Dismiss');
    if (retryable) toast.onAction().subscribe(retry);
  });
}

/**
 * Whether the text made it onto the clipboard. Browsers may refuse a write
 * that does not follow a tap — Safari in particular — which is no reason to
 * hold up the failure toast.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (!text || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
