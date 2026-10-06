/**
 * session-time.ts — reading a session's clock time, and checking that a cited
 * text states it.
 *
 * Stored times use one spelling, `H:MM AM` / `H:MM PM` (what the CSV import
 * and the public pages already use). `canonicalTime` turns a value into that
 * spelling or refuses it.
 *
 * `timesStatedIn` lists the times a text states. A time counts only when the
 * text says which half of the day it is in:
 *  - `9am`, `9:00 a.m.`, `3 PM`, `noon`, `midnight`;
 *  - 24-hour clock with minutes: `15:00`, `09:30` (a leading zero or an hour
 *    from 13 is a 24-hour reading);
 *  - the first half of a range whose second half has one: `9-3pm`,
 *    `9:00 – 11:30 a.m.`. The first time takes the second's half of the day
 *    when that keeps the range in order (`1-4pm` is 1 PM), and otherwise the
 *    other half (`9-3pm` is 9 AM). The text states the range; this only reads
 *    it.
 * A time with nothing saying which half of the day it is in (`8:30-3:00`) is
 * not stated: a crawled time it would support is refused, never guessed. So
 * is a 24-hour time without a leading zero below 13 (`9:00–15:00` states
 * only 3 PM; the 9 is not read as 9 AM).
 */

const MERIDIEM = String.raw`(a\.?\s?m\.?|p\.?\s?m\.?)`;
const CLOCK = String.raw`(\d{1,2})(?::([0-5]\d))?`;
// One time, optionally followed by a range separator and a second time.
const TIME_OR_RANGE = new RegExp(
  String.raw`(?<![\d:])${CLOCK}\s*${MERIDIEM}?(?![\d:a-z])(?:\s*(?:-|–|—|to|until|till|through)\s*${CLOCK}\s*${MERIDIEM}?(?![\d:a-z]))?`,
  'gi',
);
const NOON_MIDNIGHT = /\b(noon|midday|midnight)\b/gi;

type Half = 'AM' | 'PM';

function halfOf(meridiem: string | undefined): Half | null {
  if (!meridiem) return null;
  return meridiem.toLowerCase().startsWith('a') ? 'AM' : 'PM';
}

function format(hour24: number, minute: number): string {
  const half: Half = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${half}`;
}

/** Minutes after midnight for a 12-hour reading, or null when the hour is not 1-12. */
function twelveHourMinutes(hour: number, minute: number, half: Half): number | null {
  if (hour < 1 || hour > 12) return null;
  const h = hour % 12 + (half === 'PM' ? 12 : 0);
  return h * 60 + minute;
}

/** A 24-hour reading of `HH:MM` with no half of the day: only a leading zero or an hour from 13 says it is one. */
function twentyFourHourMinutes(hourText: string, minuteText: string | undefined): number | null {
  if (minuteText === undefined) return null;
  const hour = Number(hourText);
  if (hour > 23) return null;
  if (!(hourText.length === 2 && hourText.startsWith('0')) && hour < 13) return null;
  return hour * 60 + Number(minuteText);
}

function fromMinutes(total: number): string {
  return format(Math.floor(total / 60), total % 60);
}

/**
 * The stored spelling of one time value (`9:00 AM`), or null when the value
 * is not a time that says which half of the day it is in.
 */
export function canonicalTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const word = /^(noon|midday|midnight)$/i.exec(text);
  if (word) return word[1]!.toLowerCase() === 'midnight' ? '12:00 AM' : '12:00 PM';
  const match = new RegExp(`^${CLOCK}\\s*${MERIDIEM}?$`, 'i').exec(text);
  if (!match) return null;
  const [, hourText, minuteText, meridiem] = match;
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  const half = halfOf(meridiem);
  const total = half
    ? twelveHourMinutes(Number(hourText), minute, half)
    : twentyFourHourMinutes(hourText!, minuteText);
  return total === null ? null : fromMinutes(total);
}

/** A start and end time a text states as one range ("9am-3pm"), in the stored spelling. */
export interface StatedRange {
  readonly start: string;
  readonly end: string;
}

/**
 * Every time `text` states, and every range it states, in the stored
 * spelling. See the module header for what counts as stated. A range counts
 * only when its end is after its start: "09:00 - 03:00" reads as 9 AM to
 * 3 AM, which no day camp means, so it is not a range (and a crawled time
 * pair it would support is refused). `noon`/`midnight` count as range ends.
 */
export function readTimes(text: string): { times: Set<string>; ranges: StatedRange[] } {
  const times = new Set<string>();
  const ranges: StatedRange[] = [];
  const spelled = text.replace(NOON_MIDNIGHT, (word) => (word.toLowerCase() === 'midnight' ? '12:00 am' : '12:00 pm'));
  for (const match of spelled.matchAll(TIME_OR_RANGE)) {
    const [, h1, m1, mer1, h2, m2, mer2] = match;
    const firstHalf = halfOf(mer1);
    const secondHalf = halfOf(mer2);
    let second: number | null = null;
    if (h2 !== undefined) {
      second = secondHalf
        ? twelveHourMinutes(Number(h2), m2 === undefined ? 0 : Number(m2), secondHalf)
        : twentyFourHourMinutes(h2, m2);
      if (second !== null) times.add(fromMinutes(second));
    }
    const minute1 = m1 === undefined ? 0 : Number(m1);
    let first: number | null = null;
    if (firstHalf) {
      first = twelveHourMinutes(Number(h1), minute1, firstHalf);
    } else if (secondHalf && second !== null) {
      // "9-3pm": the range says the half of the day once, for both ends.
      const same = twelveHourMinutes(Number(h1), minute1, secondHalf);
      const other = twelveHourMinutes(Number(h1), minute1, secondHalf === 'AM' ? 'PM' : 'AM');
      first = same !== null && same <= second ? same : other !== null && other <= second ? other : null;
    } else {
      first = twentyFourHourMinutes(h1!, m1);
    }
    if (first !== null) times.add(fromMinutes(first));
    if (first !== null && second !== null && second > first) {
      const range = { start: fromMinutes(first), end: fromMinutes(second) };
      if (!ranges.some((r) => r.start === range.start && r.end === range.end)) ranges.push(range);
    }
  }
  return { times, ranges };
}

/** Every time `text` states, in the stored spelling. */
export function timesStatedIn(text: string): Set<string> {
  return readTimes(text).times;
}

/**
 * Whether `text` states exactly one range, and it is `start`–`end`. A text
 * with two ranges ("half day 9-12, full day 9-3") does not say which one a
 * session has.
 */
export function textStatesOnlyRange(start: unknown, end: unknown, text: string): boolean {
  const s = canonicalTime(start);
  const e = canonicalTime(end);
  const { ranges } = readTimes(text);
  return s !== null && e !== null && ranges.length === 1 && ranges[0]!.start === s && ranges[0]!.end === e;
}

/** Minutes after midnight of a time in the stored spelling (`9:00 AM`). */
export function minutesOfCanonical(time: string): number {
  const [, h, m, half] = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(time)!;
  return (Number(h) % 12 + (half === 'PM' ? 12 : 0)) * 60 + Number(m);
}

/** Whether `text` states the time `value` (compared in the stored spelling). */
export function textStatesTime(value: unknown, text: string): boolean {
  const canonical = canonicalTime(value);
  return canonical !== null && timesStatedIn(text).has(canonical);
}
