import { parseRange } from './http-range';

describe('parseRange', () => {
  const SIZE = 1000;

  it('returns null when no Range header is present', () => {
    expect(parseRange(undefined, SIZE)).toBeNull();
  });

  it('parses a closed range', () => {
    expect(parseRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 });
  });

  it('parses an open-ended range as running to the last byte', () => {
    expect(parseRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 });
  });

  it('parses a suffix range as the final N bytes', () => {
    expect(parseRange('bytes=-200', SIZE)).toEqual({ start: 800, end: 999 });
  });

  it('clamps a suffix range longer than the blob to the whole blob', () => {
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an end beyond the blob to the last byte', () => {
    expect(parseRange('bytes=900-99999', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseRange('  bytes=0-0  ', SIZE)).toEqual({ start: 0, end: 0 });
  });

  it('reports a start past the end of the blob as unsatisfiable', () => {
    expect(parseRange('bytes=1000-1100', SIZE)).toBe('unsatisfiable');
  });

  it('reports an inverted range as unsatisfiable', () => {
    expect(parseRange('bytes=500-100', SIZE)).toBe('unsatisfiable');
  });

  it('reports a zero-length suffix range as unsatisfiable', () => {
    expect(parseRange('bytes=-0', SIZE)).toBe('unsatisfiable');
  });

  // Multi-range and non-byte units fall back to a normal 200 with the full body.
  it.each(['bytes=0-99,200-299', 'items=0-99', 'bytes=abc-def', 'bytes=-', '0-99'])(
    'returns null for the unsupported header %p',
    header => {
      expect(parseRange(header, SIZE)).toBeNull();
    }
  );
});
