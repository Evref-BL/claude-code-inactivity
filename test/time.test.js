import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHHMM, isValidTimeZone, localDate, weekday, zonedToUtc, addMinutes, addDays, formatLocal } from '../src/time.js';

const iso = (d) => d.toISOString();

test('parseHHMM and isValidTimeZone', () => {
  assert.deepEqual(parseHHMM('06:05'), { h: 6, m: 5 });
  assert.throws(() => parseHHMM('24:00'), (e) => e.code === 'bad-time');
  assert.throws(() => parseHHMM('6:00'), (e) => e.code === 'bad-time');
  assert.ok(isValidTimeZone('Europe/Paris'));
  assert.ok(!isValidTimeZone('Mars/Olympus'));
  assert.ok(!isValidTimeZone(''));
});

test('zonedToUtc: Europe/Paris, New York, Kolkata (no DST in Kolkata)', () => {
  assert.equal(iso(zonedToUtc('2026-11-19', '06:00', 'Europe/Paris')), '2026-11-19T05:00:00.000Z');
  assert.equal(iso(zonedToUtc('2026-07-01', '06:00', 'Europe/Paris')), '2026-07-01T04:00:00.000Z');
  assert.equal(iso(zonedToUtc('2026-11-19', '06:00', 'America/New_York')), '2026-11-19T11:00:00.000Z');
  assert.equal(iso(zonedToUtc('2026-07-01', '06:00', 'America/New_York')), '2026-07-01T10:00:00.000Z');
  assert.equal(iso(zonedToUtc('2026-11-19', '06:00', 'Asia/Kolkata')), '2026-11-19T00:30:00.000Z');
  assert.equal(iso(zonedToUtc('2026-11-19', '06:00', 'UTC')), '2026-11-19T06:00:00.000Z');
});

test('zonedToUtc: DST gap moves forward, overlap takes the first occurrence', () => {
  // 2027-03-28: Paris jumps from 02:00 to 03:00 (CET -> CEST)
  assert.equal(iso(zonedToUtc('2027-03-28', '02:30', 'Europe/Paris')), '2027-03-28T01:30:00.000Z');
  assert.equal(iso(zonedToUtc('2027-03-28', '03:00', 'Europe/Paris')), '2027-03-28T01:00:00.000Z');
  assert.equal(iso(zonedToUtc('2027-03-28', '01:59', 'Europe/Paris')), '2027-03-28T00:59:00.000Z');
  // 2026-10-25: Paris falls back from 03:00 to 02:00; 02:30 happens twice, the first is CEST (+2)
  assert.equal(iso(zonedToUtc('2026-10-25', '02:30', 'Europe/Paris')), '2026-10-25T00:30:00.000Z');
  assert.equal(iso(zonedToUtc('2026-10-25', '03:30', 'Europe/Paris')), '2026-10-25T02:30:00.000Z');
  // US spring forward: 2027-03-14 02:30 does not exist in New York
  assert.equal(iso(zonedToUtc('2027-03-14', '02:30', 'America/New_York')), '2027-03-14T07:30:00.000Z');
});

test('localDate, formatLocal, weekday, addDays, addMinutes', () => {
  assert.equal(localDate('2026-11-19T23:30:00Z', 'Europe/Paris'), '2026-11-20');
  assert.equal(localDate('2026-11-19T23:30:00Z', 'America/New_York'), '2026-11-19');
  assert.equal(formatLocal('2026-11-19T05:00:00Z', 'Europe/Paris'), '2026-11-19 06:00');
  assert.equal(weekday('2026-11-19'), 'thu');
  assert.equal(weekday('2026-11-22'), 'sun');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(iso(addMinutes(new Date('2026-11-19T10:00:00Z'), 90)), '2026-11-19T11:30:00.000Z');
});
