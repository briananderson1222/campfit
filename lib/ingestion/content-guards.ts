/**
 * Content guards for the ingestion pipeline.
 *
 * Closes the importer hole behind audit findings F-10 and F-03: editorial
 * review markers ("** VERIFY **") and spreadsheet/scrape instruction artifacts
 * ("… , see that row.") were admitted into live camp records because
 * `CsvIngestionAdapter.normalize()` only skipped rows whose name contained
 * "2026 notes"/"updater", and age labels fell through to a raw-text fallback
 * that copied the source cell verbatim.
 *
 * These matchers are deliberately narrow and objectively-detectable (matching
 * the launch-bar's C1/C2 discipline) so real camp copy is never rejected.
 */

// Asterisk/bracket-wrapped editorial markers and paired review keywords.
// Examples: "** VERIFY **", "**TODO**", "[[FIXME]]", "<<CHECK>>", "{{TBD}}".
const EDITORIAL_MARKER =
  /(?:\*\*|\[\[|<<|\{\{)\s*(?:verify|todo|fixme|check|tbd|xxx|placeholder|confirm|review)\b|\b(?:verify|todo|fixme|tbd|xxx)\s*(?:\*\*|\]\]|>>|\}\})/i;

// Spreadsheet/scrape instruction phrases that leak from source cells.
const INSTRUCTION_ARTIFACT =
  /\bsee (?:that|this|the) (?:row|column|cell|tab|sheet|above|below)\b|\bsee (?:above|below)\b/i;

/** True if `text` contains an editorial review marker (e.g. "** VERIFY **"). */
export function containsEditorialMarker(text: string | null | undefined): boolean {
  if (!text) return false;
  return EDITORIAL_MARKER.test(text);
}

/**
 * True if a camp `name` looks like a scrape/spreadsheet import artifact rather
 * than a real camp name — e.g. embedded instructions ("see that row."),
 * editorial markers, or "… - Now <X>, see …" renamed-provider merge fragments.
 */
export function looksLikeArtifactName(name: string | null | undefined): boolean {
  if (!name) return false;
  if (containsEditorialMarker(name)) return true;
  if (INSTRUCTION_ARTIFACT.test(name)) return true;
  // "… - Now <Something> … see …" style merge artifact.
  if (/\bnow\b.+\bsee\b/i.test(name)) return true;
  return false;
}
