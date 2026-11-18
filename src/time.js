// Zoned date/time math with Intl only (no dependency).
// Spec: docs/design.md section 9.5. Local wall times in DST gaps shift forward by the
// gap; ambiguous (repeated) wall times take the first occurrence.
import { DispatchError } from './util.js';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const formatters = new Map();

function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a zone. */
function parts(instant, tz) {
  const out = {};
  for (const p of formatterFor(tz).formatToParts(new Date(instant))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Offset (minutes, wall = utc + offset) of a zone at an instant. */
function offsetMinutes(ms, tz) {
  const p = parts(ms, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

/** @param {string} text @returns {{h:number,m:number}} */
export function parseHHMM(text) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text));
  if (!m) throw new DispatchError('bad-time', `invalid time '${text}' (expected HH:MM)`);
  return { h: Number(m[1]), m: Number(m[2]) };
}

/** @param {string} tz */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** Local calendar date 'YYYY-MM-DD' of an instant in a zone. */
export function localDate(instant, tz) {
  const p = parts(new Date(instant).getTime(), tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

function parseDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m) throw new DispatchError('bad-date', `invalid date '${dateStr}' (expected YYYY-MM-DD)`);
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

/** Calendar weekday ('mon'..'sun') of a 'YYYY-MM-DD' date. */
export function weekday(dateStr) {
  const { y, mo, d } = parseDate(dateStr);
  return WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
}

/** Date arithmetic on 'YYYY-MM-DD' strings (calendar days). */
export function addDays(dateStr, days) {
  const { y, mo, d } = parseDate(dateStr);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** @returns {Date} */
export function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + minutes * 60000);
}

/**
 * UTC instant of a local wall time. Gap: shifted forward by the gap. Overlap: first occurrence.
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} hhmm 'HH:MM'
 * @param {string} tz IANA zone
 * @returns {Date}
 */
export function zonedToUtc(dateStr, hhmm, tz) {
  const { y, mo, d } = parseDate(dateStr);
  const { h, m } = parseHHMM(hhmm);
  const naive = Date.UTC(y, mo - 1, d, h, m, 0);
  const DAY = 24 * 3600 * 1000;
  const before = offsetMinutes(naive - DAY, tz);
  const after = offsetMinutes(naive + DAY, tz);
  const valid = [];
  for (const o of new Set([before, after])) {
    const t = naive - o * 60000;
    if (offsetMinutes(t, tz) === o) valid.push(t);
  }
  if (valid.length > 0) return new Date(Math.min(...valid));
  // Gap: the wall time does not exist; use the offset in force before the jump (lands after the gap).
  return new Date(naive - Math.min(before, after) * 60000);
}

/** 'YYYY-MM-DD HH:mm' of an instant in a zone, for human text. */
export function formatLocal(instant, tz) {
  const p = parts(new Date(instant).getTime(), tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour % 24)}:${pad(p.minute)}`;
}
