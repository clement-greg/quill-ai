import { HttpErrorResponse } from '@angular/common/http';
import { TimeoutError } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Subject } from 'rxjs';
import { generationFailure, reportGenerationFailure } from './generation-failure';

describe('generationFailure', () => {
  it('offers a retry after a client-side timeout', () => {
    expect(generationFailure(new TimeoutError())).toEqual({
      reason: 'the request took too long and was given up on',
      retryable: true,
    });
  });

  it('says the connection is down when the request never reached the server', () => {
    const result = generationFailure(new HttpErrorResponse({ status: 0 }));
    expect(result.reason).toMatch(/no connection/);
    expect(result.retryable).toBe(true);
  });

  it("passes the server's own reason through", () => {
    const err = new HttpErrorResponse({ status: 502, error: { error: '  Receiver offline  ' } });
    expect(generationFailure(err)).toEqual({ reason: 'Receiver offline', retryable: true });
  });

  it('does not offer a retry for a request the server rejected as wrong', () => {
    const err = new HttpErrorResponse({ status: 400, error: { error: 'A prompt is required' } });
    expect(generationFailure(err)).toEqual({ reason: 'A prompt is required', retryable: false });
  });

  it('offers a retry when rate limited', () => {
    expect(generationFailure(new HttpErrorResponse({ status: 429 })).retryable).toBe(true);
  });

  it('falls back to the status when there is no reason in the body', () => {
    expect(generationFailure(new HttpErrorResponse({ status: 503 })).reason).toBe('server returned 503');
  });

  it('handles an error that is not an HTTP response', () => {
    expect(generationFailure(new Error('boom'))).toEqual({
      reason: 'something went wrong sending the request',
      retryable: true,
    });
  });
});

describe('reportGenerationFailure', () => {
  let action: Subject<void>;
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    action = new Subject<void>();
    snackBar = { open: vi.fn(() => ({ onAction: () => action })) };
    writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
  });

  afterEach(() => vi.unstubAllGlobals());

  const report = (err: unknown, retry = vi.fn()) => {
    reportGenerationFailure(snackBar as unknown as MatSnackBar, 'Video', err, 'she waves', retry);
    return retry;
  };

  it('copies the prompt and says so', async () => {
    report(new HttpErrorResponse({ status: 502, error: { error: 'Receiver offline' } }));
    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith(
        'Video failed: Receiver offline (prompt copied to clipboard)', 'Retry'
      )
    );
    expect(writeText).toHaveBeenCalledWith('she waves');
  });

  it('still reports the failure when the clipboard refuses the write', async () => {
    writeText.mockRejectedValue(new Error('NotAllowedError'));
    report(new HttpErrorResponse({ status: 502, error: { error: 'Receiver offline' } }));
    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith('Video failed: Receiver offline', 'Retry')
    );
  });

  it('runs the retry when the toast action is taken', async () => {
    const retry = report(new HttpErrorResponse({ status: 502 }));
    await vi.waitFor(() => expect(snackBar.open).toHaveBeenCalled());
    action.next();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('offers only Dismiss when sending again would not help', async () => {
    report(new HttpErrorResponse({ status: 400, error: { error: 'A prompt is required' } }));
    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith(
        'Video failed: A prompt is required (prompt copied to clipboard)', 'Dismiss'
      )
    );
  });
});
