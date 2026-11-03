import { describe, expect, it } from 'vitest';
import { resolveLocalDateTime, zonedToUtc } from '../src/utils/time';

const IST = 'Asia/Kolkata';

describe('resolveLocalDateTime', () => {
  // 2026-11-03T23:18Z is 04:48 IST on 4 Nov: "tomorrow" must be 5 Nov, never 4 Nov.
  const now = new Date('2026-11-03T23:18:00Z');
  it('resolves "tomorrow 09:00" in IST correctly even in the early morning', () => {
    expect(resolveLocalDateTime('tomorrow', '09:00', now, IST).toISOString()).toBe('2026-11-05T03:30:00.000Z');
  });
  it('resolves "today 18:00" in IST using the local (not UTC) date', () => {
    expect(resolveLocalDateTime('today', '18:00', now, IST).toISOString()).toBe('2026-11-04T12:30:00.000Z');
  });
  it('accepts explicit dates and rejects impossible ones', () => {
    expect(resolveLocalDateTime('2026-12-25', '07:30', now, IST).toISOString()).toBe('2026-12-25T02:00:00.000Z');
    expect(() => resolveLocalDateTime('2026-02-30', '07:30', now, IST)).toThrow(/does not exist/);
    expect(() => resolveLocalDateTime('someday', '07:30', now, IST)).toThrow();
    expect(() => resolveLocalDateTime('today', '25:00', now, IST)).toThrow();
  });
  it('handles daylight-saving zones (US Eastern)', () => {
    // 2026-03-08 is the spring-forward date: 09:00 EDT = 13:00Z, while 2026-03-07 09:00 EST = 14:00Z.
    expect(zonedToUtc(2026, 3, 8, 9, 0, 'America/New_York').toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(zonedToUtc(2026, 3, 7, 9, 0, 'America/New_York').toISOString()).toBe('2026-03-07T14:00:00.000Z');
  });
});
