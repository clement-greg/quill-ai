import { HttpErrorResponse } from '@angular/common/http';
import { TimeoutError } from 'rxjs';
import { generationFailure } from './generation-failure';

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
