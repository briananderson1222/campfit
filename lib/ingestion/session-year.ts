/**
 * session-year.ts — the year of a session date whose own line states none.
 *
 * A date is kept when the text it cites states its year (the year-in-quote
 * rule, traverse-item-grouping.ts). Many pages state the year once, in a
 * heading ("2027 Camp Dates"), above lines like "Week 1: June 28 – July 2".
 * Owner decision: such a date may take its year from a second excerpt on the
 * same page, which must be on the stored page and is shown to the reviewer
 * beside the session. Nothing is guessed: when no excerpt settles the year,
 * the date is refused as before.
 *
 * The year excerpt is derived from the prepared page text (the text the
 * extraction's `chars:` locators point into), never from how the model cut
 * its citation, and only by one of two explicit rules. Both need the date's
 * own line(s) to state no year at all, and the session to fall within one
 * year (a range across a year boundary needs both years on its own line).
 *
 *  1. Governing heading. The nearest heading line (a Markdown `#` line) above
 *     the session's line, with no other heading between them, states exactly
 *     one year, the text under that heading (to the next heading) states no
 *     other year, and the date is in that year. Other years elsewhere on the
 *     page do not matter: this heading is the one that heads the session.
 *  2. Only year on the page. The governing heading states no year (or there
 *     is none), the WHOLE page states exactly one year, the date is in it,
 *     and a line above the session states it without stating a date (a
 *     "Registration opens Jan 5, 2027" line is not the session's year).
 *
 * Anything else is refused: a heading stating two years ("2026-27"), a page
 * stating two years with no governing heading year, a year that is not the
 * date's, a page text that is not available.
 */

const MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;
const NUMERIC_DATE_RE = /\b\d{1,2}\/\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/;

/** Whether a text states a calendar date ("June 14", "June 14th", "14 June", "6/14", "2027-06-14"). */
export function statesADate(text: string): boolean {
  return MONTH_DAY_RE.test(text) || NUMERIC_DATE_RE.test(text);
}

/**
 * Two readings of the years a text states.
 *
 * The BROAD reading takes every number that could be a year. It is the single
 * source of truth for what years a date line, a heading's section or a page
 * states, and it is used wherever another year makes a rule refuse: reading
 * too much there can only make a rule refuse. It takes:
 *  - every four-digit 1900–2099 not glued to other digits or a currency sign
 *    (also a phone number's "555-2027", a street number, a URL path, a room
 *    number, a year glued to a table cell's time "20279:00");
 *  - every two-digit number chained after such a year by up to three
 *    non-alphanumeric characters (any dash, "/", ",", ";", "|", "~", "+",
 *    "·", an apostrophe...) or by "to", "through", "thru", "and", "or", "&":
 *    "2026-27", "2026 '27", "2026/27/28", "2026 - 12 spots". Two exceptions
 *    only: a valid time ("10:00" with the hour 0-23 and minutes 00-59, or
 *    "9 am" with the hour 1-12) ends the chain, and so does a date written
 *    year first ("2027-06-14");
 *  - a numeric date's two-digit year ("6/14/26"), an abbreviated year ("Summer
 *    '26") and a fiscal year ("FY27", "FY'27").
 * Any Unicode decimal digit (full-width, Arabic-Indic, Devanagari,
 * mathematical, and superscripts after NFKC) is read as its ASCII digit.
 * A two-digit year after a month and day and a comma ("June 18, 27") is read
 * when the text also states a four-digit year. A valid time inside a chain
 * is skipped and the chain read on ("2026 10 am - 27").
 *
 * The CLEAR reading takes only a standalone four-digit year: at the start of
 * the text or after a space, "(", a quote or a Markdown marker, or as the year
 * of a numeric date ("6/14/2027"); followed by the end, a space or
 * punctuation; not after a label for a number ("Room", "Suite", "Tuition", a
 * phone or price word) and not before a street or amount word ("Pine Street",
 * "per week"). A year excerpt must state its year this way, and every number
 * in it that the broad reading takes must be one the clear reading takes too
 * (`clearYearsIn`); otherwise it is not a year excerpt.
 */
const FOUR_DIGIT_YEAR_RE = /(?<![\d$£€])((?:19|20)\d{2})(?=\d{1,2}:\d{2}|(?!\d))/g;
const CHAINED_TWO_DIGITS_RE = /^(?:[^\p{L}\p{N}\n]+|\s*(?:to|through|thru|till|until|and|or|&)\s+)['’‘]?(\d{2})(?!\d)/iu;
const NUMERIC_DATE_SHORT_YEAR_RE = /(?<![\d/])\d{1,2}\/\d{1,2}\/(\d{2})(?![\d/])/g;
const ABBREVIATED_YEAR_RE = /(?<![A-Za-z\d])['’‘](\d{2})(?![\d'’])/g;
const FISCAL_YEAR_RE = /(?<![A-Za-z])FY[\s'’‘\-‐‑‒–—―−]*(\d{2})(?!\d)/gi;
const MONTH_WORD = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?`;
/** A two-digit year after a month, a day and a comma ("June 18, 27"). */
const MONTH_DAY_SHORT_YEAR_RE = new RegExp(String.raw`\b${MONTH_WORD}\s+\d{1,2}(?:st|nd|rd|th)?,\s*['’‘]?(\d{2})(?!\d)`, "gi");

const CLEAR_YEAR_RE = /(?<=^|[\s("'“‘[*_])((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)?\d{2}))?(?=$|[\s.,;:!?)"”’\]*_])/g;
const NUMERIC_DATE_YEAR_RE = /(?<![\d/])\d{1,2}\/\d{1,2}\/((?:19|20)\d{2})(?![\d/])/g;
/** Words before a number that make it a label's number, not a year. */
const NUMBER_LABEL_RE = /(?:^|[^a-z])(?:room|rm|suite|ste|unit|apt|apartment|building|bldg|no|number|box|lot|route|rte|highway|hwy|exit|call|phone|tel|telephone|fax|text|ext|code|zip|id|tuition|price|cost|costs|fee|fees|deposit|total|rate|amount|pay|only|just|save|over|under|about|approximately|nearly|almost|up to)[\s.:#-]*$/i;
/** Words after a number that make it an address or an amount, not a year. */
const AFTER_NUMBER_RE = /^[\s,]*(?:[NSEW]\.?\s+)?(?:[A-Z][a-z]+\s+)*(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl|parkway|pkwy|highway|hwy|circle|cir|terrace|trail|suite|ste)\b|^\s*(?:per|each|dollars|usd|a week|a session|\/)/i;

function addYear(years: Set<number>, first: number, second: string | undefined): void {
  years.add(first);
  if (second === undefined) return;
  years.add(second.length === 4 ? Number(second) : first - (first % 100) + Number(second));
}

/**
 * Every Unicode decimal digit as its ASCII digit (after NFKC, which folds
 * full-width and superscript digits). A decimal digit's value is its position
 * in its run of consecutive decimal digits, modulo ten (Unicode encodes each
 * script's 0-9 as one run; the mathematical digits as five runs in a row).
 */
function normalizeDigits(text: string): string {
  return text.normalize("NFKC").replace(/\p{Nd}/gu, (digit) => {
    const code = digit.codePointAt(0)!;
    if (code >= 0x30 && code <= 0x39) return digit;
    let position = 0;
    while (/\p{Nd}/u.test(String.fromCodePoint(code - position - 1))) position++;
    return String(position % 10);
  });
}

/** Whether `hour` followed by `after` is a valid time: H:MM (H 0-23, MM 00-59) or H am/pm (H 1-12). */
function isValidTime(hour: number, after: string): boolean {
  if (/^:[0-5]\d(?!\d)/.test(after)) return hour <= 23;
  if (/^\s*[ap]\.?\s?m\b/i.test(after)) return hour >= 1 && hour <= 12;
  return false;
}

/** Every number in a text that could be a year (the broad reading). */
export function yearsStatedIn(raw: string): Set<number> {
  const text = normalizeDigits(raw);
  const years = new Set<number>();
  for (const match of text.matchAll(FOUR_DIGIT_YEAR_RE)) {
    const first = Number(match[1]);
    years.add(first);
    let rest = text.slice(match.index! + match[1]!.length);
    for (let chained = CHAINED_TWO_DIGITS_RE.exec(rest); chained; chained = CHAINED_TWO_DIGITS_RE.exec(rest)) {
      const after = rest.slice(chained[0].length);
      const value = Number(chained[1]);
      if (isValidTime(value, after)) {
        // A time is not a year; read on after it ("2026 10 am - 27").
        rest = after.replace(/^(?::[0-5]\d|\s*[ap]\.?\s?m\b\.?)/i, "");
        continue;
      }
      // A date written year first ("2027-06-14", "2027/06/14"): month, then day.
      const separator = chained[0].slice(0, chained[0].length - 2);
      const day = /^([-/.])(\d{1,2})(?!\d)/.exec(after);
      if (/^[-/.]$/.test(separator) && day && day[1] === separator && value >= 1 && value <= 12 && Number(day[2]) >= 1 && Number(day[2]) <= 31) break;
      years.add(first - (first % 100) + value);
      rest = after;
    }
  }
  for (const match of text.matchAll(NUMERIC_DATE_SHORT_YEAR_RE)) years.add(2000 + Number(match[1]));
  for (const match of text.matchAll(ABBREVIATED_YEAR_RE)) years.add(2000 + Number(match[1]));
  for (const match of text.matchAll(FISCAL_YEAR_RE)) years.add(2000 + Number(match[1]));
  if (years.size > 0) for (const match of text.matchAll(MONTH_DAY_SHORT_YEAR_RE)) years.add(2000 + Number(match[2]));
  return years;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A date with its own four-digit year: "June 14, 2026", "June 14th 2026",
 * "14 June 2026", "6/14/2026". A day needs a month name (a whole word:
 * "Mayfield 5" is not May) or a numeric month/day, and sits right next to
 * it: "Class of 3, 2027", "Grades 1-5, 2027" and "Week 2 June 2026" are not
 * dates.
 */
const FULL_DATE_RE = new RegExp(
  String.raw`\b${MONTH_WORD}\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})(?!\d)` +
    String.raw`|(?<!\d)(?<!\p{L}\s+)(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_WORD},?\s+((?:19|20)\d{2})(?!\d)` +
    String.raw`|(?<![\d/])(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})(?![\d/])`,
  "giu",
);
/** Every date mention on a line, with or without a year: a line stating a third date is not one session's two. */
const ANY_DATE_RE = new RegExp(
  String.raw`\b${MONTH_WORD}\s+\d{1,2}(?!\d)|(?<!\d)\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_WORD}|(?<![\d/])\d{1,2}\/\d{1,2}(?![\d])`,
  "gi",
);
/** What may stand between the two dates of one session: a range joiner ("-", "~", "to", "through", "thru", "until", "till"), nothing else. */
const RANGE_JOINER_RE = /^\s*(?:[-‐‑‒–—―−~]|to|through|thru|until|till)\s*$/i;

function isoDate(year: number, month: number, day: number): string | null {
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * A date line that states more than one year is accepted only as one session
 * stated in full across a year boundary: exactly two dates, each followed by
 * its own four-digit year, joined by a range joiner ("-", "to", "through",
 * "until"), the second not before the first, and no other year on the line.
 * Returns the two dates, `YYYY-MM-DD`, or null.
 */
export function sessionStatedInFull(line: string): { start: string; end: string } | null {
  const dates: { iso: string; from: number; to: number; year: number }[] = [];
  for (const match of line.matchAll(FULL_DATE_RE)) {
    const g = match;
    let iso: string | null = null;
    let year = 0;
    if (g[1] !== undefined) {
      year = Number(g[3]);
      iso = isoDate(year, MONTHS.indexOf(g[1].slice(0, 3).toLowerCase()) + 1, Number(g[2]));
    } else if (g[5] !== undefined) {
      year = Number(g[6]);
      iso = isoDate(year, MONTHS.indexOf(g[5].slice(0, 3).toLowerCase()) + 1, Number(g[4]));
    } else {
      year = Number(g[9]);
      iso = isoDate(year, Number(g[7]), Number(g[8]));
    }
    if (iso === null) return null;
    dates.push({ iso, from: match.index!, to: match.index! + match[0].length, year });
  }
  if (dates.length !== 2) return null;
  if ([...line.matchAll(ANY_DATE_RE)].length !== 2) return null;
  const [first, second] = dates as [typeof dates[0], typeof dates[0]];
  if (!RANGE_JOINER_RE.test(line.slice(first.to, second.from))) return null;
  if (second.iso < first.iso) return null;
  const years = yearsStatedIn(line);
  if (years.size !== 2 || !years.has(first.year) || !years.has(second.year)) return null;
  return { start: first.iso, end: second.iso };
}

/**
 * The years a text clearly states, or null when it has a number that could be
 * a year but is not clearly one (a phone number, a street number, a price):
 * such a text is not a year excerpt.
 */
export function clearYearsIn(text: string): Set<number> | null {
  const clear = new Set<number>();
  for (const match of text.matchAll(CLEAR_YEAR_RE)) {
    const at = match.index!;
    if (NUMBER_LABEL_RE.test(text.slice(0, at))) continue;
    if (AFTER_NUMBER_RE.test(text.slice(at + match[0].length))) continue;
    addYear(clear, Number(match[1]), match[2]);
  }
  for (const match of text.matchAll(NUMERIC_DATE_YEAR_RE)) clear.add(Number(match[1]));
  const broad = yearsStatedIn(text);
  if (broad.size !== clear.size || [...broad].some((year) => !clear.has(year))) return null;
  return clear;
}

/** The excerpt a session date takes its year from: verbatim page text and its `chars:` locator. */
export interface YearCitation {
  excerpt: string;
  locator: string;
}

export type SessionYear =
  | { ok: true; year: number; citation: YearCitation; rule: "governing-heading" | "only-year-on-page" }
  | { ok: false; why: string };

interface Line {
  start: number;
  end: number;
}

/** The page's non-blank lines, in order. */
function pageLines(text: string): Line[] {
  const lines: Line[] = [];
  for (let at = 0; at <= text.length;) {
    const next = text.indexOf("\n", at);
    const end = next < 0 ? text.length : next;
    if (text.slice(at, end).trim()) lines.push({ start: at, end });
    if (next < 0) break;
    at = next + 1;
  }
  return lines;
}

function isHeading(text: string): boolean {
  return /^#{1,6}\s/.test(text.trimStart());
}

/** A line's text without surrounding space, with the exact locator of what is kept. */
function lineCitation(text: string, line: Line): YearCitation {
  const raw = text.slice(line.start, line.end);
  const lead = raw.length - raw.trimStart().length;
  const excerpt = raw.trim();
  const start = line.start + lead;
  return { excerpt, locator: `chars:${start}-${start + excerpt.length}` };
}

function yearList(years: Iterable<number>): string {
  return [...years].sort((a, b) => a - b).join(", ");
}

/**
 * The year a session's dates take from elsewhere on the page, with the
 * excerpt that states it, or why none is taken. `dates` are the session's
 * proposed start and (if any) end date, `YYYY-MM-DD`, each with the `chars:`
 * locator of the text it cites in `preparedText`.
 */
export function sessionYearFromPage(
  dates: readonly { value: string; locator: string }[],
  preparedText: string | undefined,
): SessionYear {
  if (preparedText === undefined) return { ok: false, why: "the page text it was read from is not available, so no other excerpt can give its year" };
  if (dates.length === 0) return { ok: false, why: "no date to place" };
  const valueYears = new Set(dates.map((date) => Number(date.value.slice(0, 4))));
  if (valueYears.size !== 1) {
    return { ok: false, why: `it runs across a year boundary (${yearList(valueYears)}); a year is taken from another excerpt only for a session within one year, so both years must be stated on its own line` };
  }
  const days = dates.map((date) => date.value.slice(0, 10));
  if (days.length === 2 && days[1]! < days[0]!) {
    return { ok: false, why: `its end date (${days[1]}) is before its start date (${days[0]}); a range across a year boundary needs both years stated on its own line` };
  }
  const year = [...valueYears][0]!;

  const lines = pageLines(preparedText);
  const lineOf = (offset: number) => lines.findIndex((line) => offset >= line.start && offset <= line.end);
  const covered = new Set<number>();
  for (const date of dates) {
    const m = /^chars:(\d+)-(\d+)$/.exec(date.locator);
    const from = m ? lineOf(Number(m[1])) : -1;
    const to = m ? lineOf(Math.max(Number(m[1]), Number(m[2]) - 1)) : -1;
    if (from < 0 || to < 0) return { ok: false, why: "its place on the page could not be read" };
    for (let index = from; index <= to; index++) covered.add(index);
  }
  const lineText = (index: number) => preparedText.slice(lines[index]!.start, lines[index]!.end);
  // A citation the model stretched up to a heading ("## 2027 Camp Dates /
  // Week 1: ... / Week 2: ...") covers lines that are not the session's; its
  // own lines are then those that state a date.
  // Only a stretched citation (one that covers a heading or several date
  // lines) has lines that are not the session's own: a year on the session's
  // label line or in its year cell ("Summer 2027 Session 1 / June 14 - 18") is
  // its own.
  const dateLines = new Set([...covered].filter((index) => statesADate(lineText(index))));
  const stretched = [...covered].some((index) => isHeading(lineText(index))) || dateLines.size > 1;
  const ownLines = stretched && dateLines.size > 0 ? dateLines : covered;
  const ownYears = new Set([...ownLines].flatMap((index) => [...yearsStatedIn(lineText(index))]));
  if (ownYears.size > 0) {
    return { ok: false, why: `its own line states ${yearList(ownYears)} but not with this date (${year}); a year is taken from another excerpt only when the session's own line states none` };
  }

  const firstOwn = Math.min(...ownLines);
  const lastOwn = Math.max(...ownLines);
  // The heading over the session: the nearest heading above its first own
  // line. A heading among or below its own lines (a citation stretched across
  // two sections) leaves which section the session is in unsettled.
  for (let index = firstOwn + 1; index <= Math.max(lastOwn, ...covered); index++) {
    if (!ownLines.has(index) && isHeading(lineText(index))) {
      return { ok: false, why: `its cited text runs past the heading "${lineText(index).trim()}", so which heading is over the session is not settled` };
    }
  }
  const lastCovered = Math.max(...covered);
  let heading = -1;
  for (let index = firstOwn - 1; index >= 0; index--) {
    if (isHeading(lineText(index))) {
      heading = index;
      break;
    }
  }

  const headingNumbers = heading >= 0 ? yearsStatedIn(lineText(heading)) : new Set<number>();
  const headingYears = headingNumbers.size > 0 ? clearYearsIn(lineText(heading)) : new Set<number>();
  if (headingYears === null) {
    return { ok: false, why: `the heading over it ("${lineText(heading).trim()}") has a number that may or may not be a year; which year applies is not settled` };
  }
  if (headingYears.size > 1) {
    return { ok: false, why: `the heading over it ("${lineText(heading).trim()}") states more than one year (${yearList(headingYears)}); which one applies is not settled` };
  }
  if (headingYears.size === 1) {
    const stated = [...headingYears][0]!;
    let sectionEnd = lines.length;
    for (let index = Math.max(heading, lastCovered) + 1; index < lines.length; index++) {
      if (isHeading(lineText(index)) && !ownLines.has(index)) {
        sectionEnd = index;
        break;
      }
    }
    const sectionYears = new Set<number>();
    for (let index = heading + 1; index < sectionEnd; index++) for (const y of yearsStatedIn(lineText(index))) sectionYears.add(y);
    sectionYears.delete(stated);
    if (sectionYears.size > 0) {
      return { ok: false, why: `the heading over it states ${stated}, but the text under that heading also states ${yearList(sectionYears)}; which one applies is not settled` };
    }
    if (stated !== year) return { ok: false, why: `its year (${year}) is not the year the heading over it states (${stated})` };
    return { ok: true, year, citation: lineCitation(preparedText, lines[heading]!), rule: "governing-heading" };
  }

  const pageYears = yearsStatedIn(preparedText);
  if (pageYears.size === 0) return { ok: false, why: "no text on the page states a year" };
  if (pageYears.size > 1) {
    return { ok: false, why: `the page states ${pageYears.size} different years (${yearList(pageYears)}) and the heading over it states none; which one applies is not settled` };
  }
  const only = [...pageYears][0]!;
  if (only !== year) return { ok: false, why: `its year (${year}) is not the one year the page states (${only})` };
  for (let index = firstOwn - 1; index >= 0; index--) {
    const text = lineText(index);
    const clear = clearYearsIn(text);
    if (clear !== null && clear.size === 1 && clear.has(year) && !statesADate(text)) {
      return { ok: true, year, citation: lineCitation(preparedText, lines[index]!), rule: "only-year-on-page" };
    }
  }
  return { ok: false, why: `no line above it clearly states ${year} as a year without also stating a date` };
}

/**
 * Whether a citation was stretched past the session's own text: it covers a
 * heading, or several date lines (other sessions'). A year on the session's
 * own label line or year cell ("Summer 2027 Session 1 / June 14 - 18") does
 * not make it stretched.
 */
export function isStretchedCitation(excerpt: string): boolean {
  const lines = excerpt.split("\n").filter((line) => line.trim());
  return lines.some((line) => isHeading(line)) || lines.filter((line) => statesADate(line)).length > 1;
}

/**
 * The year-in-quote rule for a session date (`value`, `YYYY-MM-DD`, the
 * session's start or end). The whole citation, every line of it, must state
 * exactly {Y} by the broad reading (`yearsStatedIn`, valid times excepted):
 * a citation stating more than one year anywhere ("2026–2027 School Year /
 * Week 1: June 14 - 18") states none of them. One exception: a date line
 * stating a session in full across a year boundary (`sessionStatedInFull`),
 * only for its own start date as the start and its own end date as the end,
 * and only when no other line of the citation states a year. Otherwise a
 * citation that is not stretched
 * keeps today's rule (it states the year), and a stretched citation ("## 2027
 * Camp Dates / Week 1: June 28 – July 2 / Week 2: ...") must state the year on
 * one of its date lines: the heading is not the date's own text, and its year
 * is taken only by the rules above, shown as the year excerpt.
 */
export function yearOnADateLine(excerpt: string, value: string, role: "start" | "end"): boolean {
  const year = Number(value.slice(0, 4));
  const lines = excerpt.split("\n").filter((line) => line.trim());
  const dateLines = lines.filter((line) => statesADate(line));
  // The one way a citation stating more than one year counts: a date line
  // stating one session in full across a year boundary, this date being its
  // start or end as given, and no other line of the citation stating a year.
  for (const line of dateLines) {
    if (yearsStatedIn(line).size <= 1) continue;
    const session = sessionStatedInFull(line);
    return session !== null && session[role] === value.slice(0, 10)
      && lines.every((other) => other === line || yearsStatedIn(other).size === 0);
  }
  // Otherwise the whole citation, every line of it, states exactly this year.
  const stated = new Set(lines.flatMap((line) => [...yearsStatedIn(line)]));
  if (stated.size !== 1 || !stated.has(year)) return false;
  if (!isStretchedCitation(excerpt)) return excerpt.includes(String(year));
  return dateLines.some((line) => {
    const years = yearsStatedIn(line);
    return years.size === 1 && years.has(year);
  });
}

/** Whether any line of a citation states more than one year in the broad reading. */
export function statesSeveralYearsOnALine(excerpt: string): boolean {
  return excerpt.split("\n").some((line) => yearsStatedIn(line).size > 1);
}

/** Whether a year excerpt clearly states exactly one year, with no other number that could be one, and it is every one of `dates`' year (the review-apply check). */
export function excerptStatesOnlyYearOf(excerpt: string, dates: readonly unknown[]): boolean {
  const years = clearYearsIn(excerpt);
  if (years === null || years.size !== 1) return false;
  const year = [...years][0]!;
  const values = dates.filter((date) => date !== null && date !== undefined && date !== "");
  return values.length > 0 && values.every((date) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date) && Number(date.slice(0, 4)) === year);
}
