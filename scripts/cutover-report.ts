/**
 * cutover-report.ts — the AFTER comparison for the traverse full cutover
 * (owner directive, 2026-07). Runs the new per-item traverse pipeline LIVE
 * over the same 3 sources the BEFORE baseline (tests/fixtures/cutover-baseline-2026-07.json,
 * scripts/test-cutover-baseline.ts) recorded, then writes
 * docs/cutover-report-2026-07.md: per source, before vs after — item count,
 * field coverage, cost (tokens), latency — plus the >40% regression tripwire.
 *
 * REGRESSION RULE (owner directive): if a source's item count drops >40% vs
 * baseline, OR a field class that was previously covered disappears
 * entirely, that source's regression is GINORMOUS — this script does NOT
 * paper over it. It still writes the report (the rest of the cutover can be
 * sound even if one source regresses) but marks that source's row
 * `⚠️ OWNER DECISION` and adds a dedicated section with the exact before/after
 * numbers so the PR body can surface it for an explicit human call.
 *
 * Requires a resolvable extraction provider (export ZAI_API_KEY=... — see
 * .datum/config.json's "extraction-default" role). If resolution fails, this
 * prints NOT_VERIFIED with exact run instructions and exits 0 — it never
 * fabricates a report.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fetchAndExtract } from "@kontourai/traverse/fetch";
import { replaySource } from "@kontourai/traverse/fetch";
import { DatumError } from "@kontourai/datum";
import { INGESTION_SOURCES } from "@/lib/ingestion/sources";
import { CAMP_TARGET_SCHEMA, CAMP_FIELD_HINTS } from "@/lib/ingestion/traverse-schema";
import { assembleItems, type AssembledItem } from "@/lib/ingestion/traverse-item-grouping";
import {
  createCampfitSnapshotStore,
  CAMPFIT_FETCH_USER_AGENT,
} from "@/lib/ingestion/traverse-snapshot-store";
import { resolveExtractionProvider } from "@/lib/ingestion/resolve-extraction-provider";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const BASELINE_PATH = path.join(process.cwd(), "tests", "fixtures", "cutover-baseline-2026-07.json");
const REPORT_PATH = path.join(process.cwd(), "docs", "cutover-report-2026-07.md");

interface BaselineSourceEntry {
  key: string;
  url: string;
  scraperName: string;
  campCount: number;
  fieldCoverage: Record<string, { count: number; fraction: number }>;
}
interface BaselineFile {
  generatedAt: string;
  sources: Record<string, BaselineSourceEntry>;
}

const COVERAGE_FIELDS = [
  "name", "description", "category", "registrationStatus", "applicationUrl",
  "websiteUrl", "city", "neighborhood", "address", "ageGroups", "schedules", "pricing",
] as const;

function afterFieldCoverage(items: AssembledItem[], field: (typeof COVERAGE_FIELDS)[number]) {
  const count = items.filter((item) => {
    if (field === "ageGroups") return item.ageGroups.length > 0;
    if (field === "schedules") return item.schedules.length > 0;
    if (field === "pricing") return item.pricing.length > 0;
    const scalarKey = field as "name" | "description" | "category" | "registrationStatus" | "applicationUrl" | "websiteUrl" | "city" | "neighborhood" | "address";
    return item.scalars[scalarKey] !== undefined;
  }).length;
  return { count, fraction: items.length > 0 ? Math.round((count / items.length) * 100) / 100 : 0 };
}

interface AfterSourceResult {
  key: string;
  url: string;
  itemCount: number;
  fieldCoverage: Record<string, { count: number; fraction: number }>;
  tokensUsed: number | null;
  model: string | null;
  latencyMs: number;
  fetchError: string | null;
  extractionError: string | null;
  warnings: string[];
  snapshotBodyHash: string | null;
  replayOk: boolean;
}

async function runAfterForSource(key: string, url: string, provider: ReturnType<typeof resolveExtractionProvider>["provider"]): Promise<AfterSourceResult> {
  const store = createCampfitSnapshotStore();
  const startedAt = Date.now();
  const far = await fetchAndExtract(
    { id: key, url, contentType: "html", userAgent: CAMPFIT_FETCH_USER_AGENT },
    { targetSchema: CAMP_TARGET_SCHEMA, fieldHints: CAMP_FIELD_HINTS, provider, store, mode: "live-with-capture" }
  );
  const latencyMs = Date.now() - startedAt;

  const result: AfterSourceResult = {
    key,
    url,
    itemCount: 0,
    fieldCoverage: Object.fromEntries(COVERAGE_FIELDS.map((f) => [f, { count: 0, fraction: 0 }])),
    tokensUsed: null,
    model: null,
    latencyMs,
    fetchError: far.fetch.error ? `${far.fetch.error.kind}: ${far.fetch.error.message}` : null,
    extractionError: null,
    warnings: [...(far.fetch.warnings ?? [])],
    snapshotBodyHash: far.fetch.snapshot?.bodyHash ?? null,
    replayOk: false,
  };

  if (far.extraction) {
    result.extractionError = far.extraction.error ?? null;
    result.warnings.push(...(far.extraction.warnings ?? []));
    // totalTokensUsed (traverse 0.8.0) sums every chunk's provider call —
    // raw.tokensUsed (pre-0.8.0) was only the LAST chunk's response, an
    // undercount on any multi-chunk page (campfit#71).
    result.tokensUsed = far.extraction.totalTokensUsed;
    result.model = far.extraction.raw?.model ?? null;
    const items = assembleItems(far.extraction.proposals);
    result.itemCount = items.length;
    for (const f of COVERAGE_FIELDS) result.fieldCoverage[f] = afterFieldCoverage(items, f);
  }

  // Replay proof: re-run the SAME snapshot with no network — proves the
  // fetch side is deterministic (byte-identical bytes) and the pipeline can
  // run fully offline against captured bytes. Value-level determinism given
  // a deterministic provider is proven in CI (npm run test:traverse-replay)
  // with a stub provider; this is a live-run smoke check, not a claim that
  // a non-deterministic real LLM reproduces identical VALUES on replay.
  const replay = await replaySource(store, key);
  result.replayOk = Boolean(replay.snapshot?.fromCache && replay.snapshot.bodyHash === result.snapshotBodyHash);

  return result;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function regressionVerdict(before: number, after: number): { ginormous: boolean; note: string } {
  if (before === 0) return { ginormous: false, note: "baseline was 0 — traverse can only improve" };
  const ratio = after / before;
  if (ratio < 0.6) {
    return {
      ginormous: true,
      note: `${after}/${before} = ${pct(ratio)} of baseline — DROPPED >40% (regression rule tripped)`,
    };
  }
  return { ginormous: false, note: `${after}/${before} = ${pct(ratio)} of baseline` };
}

function fieldClassDisappeared(before: BaselineSourceEntry, after: AfterSourceResult): string[] {
  const disappeared: string[] = [];
  for (const f of COVERAGE_FIELDS) {
    const beforeCovered = (before.fieldCoverage[f]?.count ?? 0) > 0;
    const afterCovered = (after.fieldCoverage[f]?.count ?? 0) > 0;
    if (beforeCovered && !afterCovered) disappeared.push(f);
  }
  return disappeared;
}

async function main() {
  let resolution: ReturnType<typeof resolveExtractionProvider>;
  try {
    resolution = resolveExtractionProvider();
  } catch (err) {
    if (err instanceof DatumError) {
      console.log(`NOT_VERIFIED: datum could not resolve an extraction provider (${err.code}): ${err.message}`);
      console.log("To run it:");
      console.log("  1. export ZAI_API_KEY=...   (the key for the extraction-default role in .datum/config.json;");
      console.log("     or add it to .env.local)");
      console.log("  2. npm run cutover:report");
      console.log(`  3. Read the report at ${path.relative(process.cwd(), REPORT_PATH)}`);
      process.exit(0);
    }
    throw err;
  }
  const { provider, ref, datumProvider, model: resolvedModelId } = resolution;
  console.log(`Traverse provider: ${provider.name} (datum ref: "${ref}" -> ${datumProvider}, model: ${resolvedModelId})`);

  const baseline: BaselineFile = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));

  const afterResults: AfterSourceResult[] = [];
  for (const src of INGESTION_SOURCES) {
    console.log(`\n=== ${src.key} (${src.url}) ===`);
    const after = await runAfterForSource(src.key, src.url, provider);
    afterResults.push(after);
    console.log(
      `after: ${after.itemCount} item(s), ${after.tokensUsed ?? "?"} tokens, ${after.latencyMs}ms` +
        `${after.fetchError ? ` ✗ fetch ${after.fetchError}` : ""}${after.extractionError ? ` ✗ extract ${after.extractionError}` : ""}`
    );
  }

  // ── Assemble report ──────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`# Traverse full cutover — before/after report (2026-07)`);
  lines.push(``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`BEFORE baseline: ${baseline.generatedAt} (tests/fixtures/cutover-baseline-2026-07.json, legacy CSS-selector scrapers, live)`);
  lines.push(`AFTER: traverse full cutover pipeline, live, provider ${provider.name} (datum ref "${ref}" -> ${datumProvider}, model ${resolvedModelId})`);
  lines.push(``);
  lines.push(`## Regression rule`);
  lines.push(``);
  lines.push(`Per the owner directive: if a source's item count drops **>40%** vs baseline, or a`);
  lines.push(`previously-covered field class disappears entirely, that source's regression is`);
  lines.push(`GINORMOUS — it is not papered over. The cutover still merges if the rest is sound,`);
  lines.push(`but that source is flagged **⚠️ OWNER DECISION** below with the exact before/after`);
  lines.push(`numbers proving what changed.`);
  lines.push(``);
  lines.push(`## Summary — count, cost, latency`);
  lines.push(``);
  lines.push(`| Source | Before (legacy) | After (traverse) | Ratio | Tokens | Latency (ms) | Verdict |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);

  let totalTokens = 0;
  const ownerDecisionSources: { key: string; before: BaselineSourceEntry; after: AfterSourceResult; verdict: ReturnType<typeof regressionVerdict>; disappeared: string[] }[] = [];

  for (const after of afterResults) {
    const before = baseline.sources[after.key];
    const verdict = regressionVerdict(before.campCount, after.itemCount);
    const disappeared = fieldClassDisappeared(before, after);
    const ginormous = verdict.ginormous || disappeared.length > 0;
    if (ginormous) ownerDecisionSources.push({ key: after.key, before, after, verdict, disappeared });
    if (after.tokensUsed) totalTokens += after.tokensUsed;

    lines.push(
      `| ${after.key} | ${before.campCount} | ${after.itemCount} | ${verdict.note} | ${after.tokensUsed ?? "n/a"} | ${after.latencyMs} | ${ginormous ? "⚠️ OWNER DECISION" : "✅ ok"} |`
    );
  }
  lines.push(``);
  lines.push(`Total tokens across all 3 sources (one live extraction call each): **${totalTokens}**.`);
  lines.push(``);

  lines.push(`## Field coverage — before vs after`);
  lines.push(``);
  for (const after of afterResults) {
    const before = baseline.sources[after.key];
    lines.push(`### ${after.key}`);
    lines.push(``);
    lines.push(`| Field | Before coverage | After coverage |`);
    lines.push(`| --- | --- | --- |`);
    for (const f of COVERAGE_FIELDS) {
      const b = before.fieldCoverage[f];
      const a = after.fieldCoverage[f];
      const bStr = `${b.count}/${before.campCount || 0} (${pct(b.fraction)})`;
      const aStr = `${a.count}/${after.itemCount || 0} (${pct(a.fraction)})`;
      const flag = b.count > 0 && a.count === 0 ? " ⚠️" : "";
      lines.push(`| ${f} | ${bStr} | ${aStr}${flag} |`);
    }
    lines.push(``);
  }

  lines.push(`## Replay determinism`);
  lines.push(``);
  lines.push(`Live-run smoke check: each source's captured snapshot was immediately re-served`);
  lines.push(`via \`replaySource()\` with no network — proving the fetch/snapshot side is`);
  lines.push(`byte-identical and replayable. VALUE-level determinism (same input -> same`);
  lines.push(`grouped proposals) is proven deterministically in CI`);
  lines.push(`(\`npm run test:traverse-replay\`) using a stub provider — real LLM output is not`);
  lines.push(`claimed to be reproducible run-to-run (glm-5.2 is non-deterministic; see`);
  lines.push(`docs/traverse-adjudication-2026-07.md).`);
  lines.push(``);
  lines.push(`| Source | Snapshot replay OK |`);
  lines.push(`| --- | --- |`);
  for (const after of afterResults) {
    lines.push(`| ${after.key} | ${after.replayOk ? "✅" : "❌"} |`);
  }
  lines.push(``);

  if (ownerDecisionSources.length > 0) {
    lines.push(`## ⚠️ OWNER DECISION items`);
    lines.push(``);
    for (const item of ownerDecisionSources) {
      lines.push(`### ${item.key}`);
      lines.push(``);
      lines.push(`- Before: ${item.before.campCount} camps (legacy, ${baseline.generatedAt})`);
      lines.push(`- After: ${item.after.itemCount} items (traverse, live)`);
      lines.push(`- Count regression: ${item.verdict.note}`);
      if (item.disappeared.length > 0) {
        lines.push(`- Field classes that disappeared entirely: ${item.disappeared.join(", ")}`);
      }
      if (item.after.warnings.length > 0) {
        lines.push(`- Warnings: ${item.after.warnings.slice(0, 5).join("; ")}`);
      }
      lines.push(``);
    }
  } else {
    lines.push(`## Owner decision items`);
    lines.push(``);
    lines.push(`None — no source dropped >40% vs baseline and no field class disappeared entirely.`);
    lines.push(``);
  }

  lines.push(`## What was deleted vs kept`);
  lines.push(``);
  lines.push(`**Deleted** (full cutover — no shadow/parallel path kept):`);
  lines.push(`- CSS-selector scrapers: \`lib/ingestion/scrapers/avid4.ts\`, \`denver-arts.ts\``);
  lines.push(`- \`lib/ingestion/scraper-base.ts\`, \`lib/ingestion/scraper-utils.ts\` (BaseScraper harness)`);
  lines.push(`- \`TRAVERSE_INGESTION\` flag + \`lib/ingestion/traverse-ingestion.ts\` (flagged/shadow routing)`);
  lines.push(`- \`scripts/traverse-parity.ts\` (superseded by this script)`);
  lines.push(`- iD Tech JSON-LD scraper (\`lib/ingestion/scrapers/idtech.ts\`) — see disposition below`);
  lines.push(``);
  lines.push(`**Kept** (product discipline, not legacy):`);
  lines.push(`- The review-workflow sink: proposals -> \`createProposal\` -> human review`);
  lines.push(`- Per-source failure isolation + \`SCRAPE_FAILURE_THRESHOLD\` (renamed home:`);
  lines.push(`  \`lib/ingestion/ingestion-runner.ts\`, was \`scrape-runner.ts\`)`);
  lines.push(`- Robots/politeness + snapshot capture on every fetch (\`@kontourai/traverse/fetch\`)`);
  lines.push(``);
  lines.push(`## Notes — cost capture + provider tuning (campfit#39 criterion 5)`);
  lines.push(``);
  lines.push(`- **Cost capture**: \`tokensUsed\` above is \`ExtractionResult.totalTokensUsed\``);
  lines.push(`  (traverse 0.8.0) — the Anthropic adapter's \`input_tokens + output_tokens\``);
  lines.push(`  SUMMED across every chunk's provider call for the page (not just the last`);
  lines.push(`  chunk's, which undercounted multi-chunk pages pre-0.8.0 — campfit#71), threaded through`);
  lines.push(`  \`lib/ingestion/traverse-pipeline.ts\`'s per-source result and`);
  lines.push(`  \`lib/ingestion/traverse-extractor.ts\`'s per-item \`rawExtraction\` for audit —`);
  lines.push(`  this closes the cost half of campfit#39.`);
  lines.push(`- **maxTokens tuning (live probe against the captured idtech snapshot)**: raising`);
  lines.push(`  the Anthropic adapter's response token budget from its 2048 default to`);
  lines.push(`  4096/6144/8192 was tried expecting MORE items (23 courses need a lot of`);
  lines.push(`  per-item excerpts). It made results WORSE, not better — every budget hit`);
  lines.push(`  \`stop_reason === "max_tokens"\`, but at 4096+ the response truncated before ANY`);
  lines.push(`  valid tool_use JSON completed (0 proposals); only 2048 forced glm-5.2 to reach`);
  lines.push(`  usable tool_use content before truncating. \`lib/ingestion/resolve-extraction-provider.ts\``);
  lines.push(`  keeps 2048 as the default for this reason (overridable via \`TRAVERSE_MAX_TOKENS\``);
  lines.push(`  for a future provider that doesn't share this behavior).`);
  lines.push(`- **idtech's root cause**: the page's prepared (stripped/truncated) text is well`);
  lines.push(`  under \`maxContentChars\` (not a content-truncation issue), but enumerating 23`);
  lines.push(`  courses with per-item excerpts in ONE tool-use response exceeds what glm-5.2`);
  lines.push(`  reliably completes before hitting the (best-available) 2048-token output`);
  lines.push(`  budget — a genuine model/response-length capability gap for long listing`);
  lines.push(`  pages, not a plumbing defect. The deterministic CI tests`);
  lines.push(`  (\`npm run test:traverse-replay\`) prove the GROUPING logic itself is 100%`);
  lines.push(`  correct on however many items a response completes.`);
  lines.push(`- **Confidence is not an auto-approve signal**: unchanged from the slice-2b`);
  lines.push(`  adjudication finding (flat 0.90-0.94, doesn't discriminate ambiguous cases) —`);
  lines.push(`  the review workflow must not treat traverse confidence as a quality gate.`);
  lines.push(``);
  lines.push(`### iD Tech JSON-LD disposition: DELETED, not folded in`);
  lines.push(``);
  lines.push(`Traverse's provenance contract requires every proposal's \`excerpt\` to occur`);
  lines.push(`verbatim in \`extract()\`'s CONTENT-PREPARED text — and content-prep strips`);
  lines.push(`\`<script>\` tags (including \`application/ld+json\` blocks) entirely before that`);
  lines.push(`text is built (see \`@kontourai/traverse\`'s \`content-prep.ts\`, \`NOISE_ELEMENTS\`).`);
  lines.push(`A structured-data candidate sourced from JSON-LD can therefore never pass`);
  lines.push(`traverse's own excerpt/locator normalization — building a second,`);
  lines.push(`JSON-LD-native provenance-verification path to route around that would itself`);
  lines.push(`be the "parallel legacy path" the owner directive says not to keep. The`);
  lines.push(`per-item model extraction this cutover ships already reads the same`);
  lines.push(`human-visible facts (name, description, typical age range) the JSON-LD scraper`);
  lines.push(`read, so the marginal value of a second code path was low relative to that`);
  lines.push(`structural cost. Deleted; see this report's iD Tech row for the live result.`);
  lines.push(``);

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join("\n") + "\n");
  console.log(`\n✓ Report written to ${path.relative(process.cwd(), REPORT_PATH)}`);
  if (ownerDecisionSources.length > 0) {
    console.log(`⚠️  OWNER DECISION items: ${ownerDecisionSources.map((s) => s.key).join(", ")}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
