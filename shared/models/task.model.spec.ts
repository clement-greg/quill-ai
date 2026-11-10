import { addDays, compareOpenTasks, normalizeDueDate, segmentTaskBody, todayIn } from './task.model';

describe('task model helpers', () => {
  it('accepts only real calendar dates', () => {
    expect(normalizeDueDate('2026-03-06')).toBe('2026-03-06');
    expect(normalizeDueDate('2026-02-30')).toBeUndefined();
    expect(normalizeDueDate('3/6/2026')).toBeUndefined();
    expect(normalizeDueDate(20260306)).toBeUndefined();
  });

  it('computes today in a time zone and adds days across months', () => {
    const now = new Date('2026-03-01T05:00:00Z');
    expect(todayIn('America/Denver', now)).toBe('2026-02-28');
    expect(todayIn('UTC', now)).toBe('2026-03-01');
    expect(todayIn('Not/AZone', now)).toBe('2026-03-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('orders dated tasks first, soonest first', () => {
    const list = [
      { dueDate: undefined, createdAt: '2026-01-02' },
      { dueDate: '2026-05-01', createdAt: '2026-01-01' },
      { dueDate: '2026-04-01', createdAt: '2026-01-01' },
    ].sort(compareOpenTasks);
    expect(list.map(t => t.dueDate)).toEqual(['2026-04-01', '2026-05-01', undefined]);
  });

  it('links every whole-word occurrence, longest phrase first, case-insensitively', () => {
    const links = [
      { kind: 'entity' as const, id: 'dale', text: 'Dale' },
      { kind: 'entity' as const, id: 'dale-full', text: 'Dale Harper' },
      { kind: 'chapter' as const, id: 'c2', text: 'chapter 2' },
    ];
    const segs = segmentTaskBody('Dale Harper meets dale in Chapter 2, not Daleford.', links);
    expect(segs.filter(s => s.link).map(s => [s.text, s.link!.id])).toEqual([
      ['Dale Harper', 'dale-full'],
      ['dale', 'dale'],
      ['Chapter 2', 'c2'],
    ]);
    expect(segs.map(s => s.text).join('')).toBe('Dale Harper meets dale in Chapter 2, not Daleford.');
  });

  it('returns the body as one run when there are no links', () => {
    expect(segmentTaskBody('plain', [])).toEqual([{ text: 'plain' }]);
    expect(segmentTaskBody('', [])).toEqual([]);
  });
});
