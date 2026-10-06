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
 * A four-digit year 1900–2099 not glued to other digits or a currency sign,
 * optionally followed by a short second year ("2026-27", "2026/27"). A short
 * year directly followed by another `-NN` is a date ("2027-06-14"), not a
 * range. Over-reading (a phone number ending in "2026") can only add a year,
 * which makes a rule refuse; it never makes one accept.
 */
const YEAR_RE = /(?<![\d$£€])((?:19|20)\d{2})(?:\s*[-–—/]\s*(\d{2})(?!\d|\s*[-–—/]\s*\d))?(?!\d)/g;

/** Every year a text states, a short range ("2026-27") stating both. */
export function yearsStatedIn(text: string): Set<number> {
  const years = new Set<number>();
  for (const match of text.matchAll(YEAR_RE)) {
    const first = Number(match[1]);
    years.add(first);
    if (match[2] !== undefined) years.add(first - (first % 100) + Number(match[2]));
  }
  return years;
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
    return { ok: false, why: "its end date is before its start date in the same year; a range across a year boundary needs both years stated on its own line" };
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
  const ownYears = new Set([...covered].flatMap((index) => [...yearsStatedIn(lineText(index))]));
  if (ownYears.size > 0) {
    return { ok: false, why: `its own line states ${yearList(ownYears)} but its cited text does not state ${year}; a year is taken from another excerpt only when the session's own line states none` };
  }

  // The session's own lines are those of its cited text that state a date (a
  // card's dates may be a heading of their own); a heading among them is not
  // the heading over the session.
  const own = new Set([...covered].filter((index) => statesADate(lineText(index))));
  const ownLines = own.size > 0 ? own : covered;
  const firstOwn = Math.min(...ownLines);
  const lastCovered = Math.max(...covered);
  let heading = -1;
  for (let index = lastCovered; index >= 0; index--) {
    if (ownLines.has(index)) continue;
    if (isHeading(lineText(index))) {
      heading = index;
      break;
    }
  }
  if (heading > firstOwn) {
    // A heading inside the cited text, below the date line: it does not head this session.
    heading = -1;
    for (let index = firstOwn - 1; index >= 0; index--) {
      if (isHeading(lineText(index))) {
        heading = index;
        break;
      }
    }
  }

  const headingYears = heading >= 0 ? yearsStatedIn(lineText(heading)) : new Set<number>();
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
    if (yearsStatedIn(text).has(year) && !statesADate(text)) {
      return { ok: true, year, citation: lineCitation(preparedText, lines[index]!), rule: "only-year-on-page" };
    }
  }
  return { ok: false, why: `no line above it states ${year} without also stating a date` };
}

/** Whether a year excerpt states exactly one year and it is every one of `dates`' year (the review-apply check). */
export function excerptStatesOnlyYearOf(excerpt: string, dates: readonly unknown[]): boolean {
  const years = yearsStatedIn(excerpt);
  if (years.size !== 1) return false;
  const year = [...years][0]!;
  const values = dates.filter((date) => date !== null && date !== undefined && date !== "");
  return values.length > 0 && values.every((date) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date) && Number(date.slice(0, 4)) === year);
}
