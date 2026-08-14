export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses a single-range `Range: bytes=…` header against a known total size.
 *
 * Returns null when the header is absent or not a form we serve (multi-range
 * requests fall back to a normal 200 with the whole body, which is legal).
 * Returns 'unsatisfiable' when the range falls outside the blob, which the
 * caller answers with a 416.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;

  if (rawStart === '') {
    // Suffix range: `bytes=-500` means the last 500 bytes.
    if (rawEnd === '') return null;
    const suffix = parseInt(rawEnd, 10);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : Math.min(parseInt(rawEnd, 10), size - 1);
  }

  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
