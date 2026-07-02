/**
 * traverse-parity.ts — LIVE parity harness for the @kontourai/traverse pilot
 * (Slice 1b). NOT part of CI. Runs BOTH the legacy selector scraper AND
 * schema-directed traverse extraction (real Anthropic provider) over the SAME
 * freshly-fetched pages, then writes a parity report to a local artifacts dir.
 *
 *   npm run traverse:parity
 *
 * Requires ANTHROPIC_API_KEY (env or .env.local). If it is absent, the harness
 * prints NOT_VERIFIED with exact run instructions and exits 0 — it never
 * fabricates a report.
 *
 * The report captures, per source:
 *   - per-field agreement (legacy value vs traverse proposal)
 *   - traverse-only finds (fields traverse proposed that legacy missed)
 *   - selector-only finds (fields legacy produced that traverse missed)
 *   - traverse confidence distribution
 * Output: artifacts/traverse-parity/<timestamp>/{report.json,report.md}
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadLocalEnv } from "./load-env";
import { Avid4Scraper } from "@/lib/ingestion/scrapers/avid4";
import { DenverArtMuseumScraper } from "@/lib/ingestion/scrapers/denver-arts";
import { BaseScraper } from "@/lib/ingestion/scraper-base";
import { CampInput } from "@/lib/ingestion/adapter";
import { runTraverseExtraction } from "@/lib/ingestion/traverse-extractor";
import { SCALAR_SCHEMA_PATHS } from "@/lib/ingestion/traverse-schema";
import type { ExtractionProposal } from "@kontourai/traverse";
import { createAnthropicExtractionProvider } from "@kontourai/traverse/anthropic";

loadLocalEnv();

const ARTIFACT_ROOT = path.join(process.cwd(), "artifacts", "traverse-parity");

interface SourceSpec {
  key: string;
  scraper: BaseScraper;
}

const SOURCES: SourceSpec[] = [
  { key: "avid4", scraper: new Avid4Scraper() },
  { key: "denver-art-museum", scraper: new DenverArtMuseumScraper() },
];

/** Fetch raw HTML with a browsery UA (mirrors the scrapers' own fetch). */
async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; CampFitBot/1.0; +https://campfit.app/bot)",
      Accept: "text/html,application/xhtml+xml,*/*",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Flatten the first legacy camp into a comparable field map. */
function legacyFields(camp: CampInput | undefined): Record<string, unknown> {
  if (!camp) return {};
  const out: Record<string, unknown> = {
    name: camp.name || null,
    description: camp.description || null,
    category: camp.category || null,
    registrationStatus: camp.registrationStatus || null,
    applicationUrl: camp.applicationUrl ?? camp.websiteUrl ?? null,
    websiteUrl: camp.websiteUrl || null,
    city: camp.city || null,
    neighborhood: camp.neighborhood || null,
    address: camp.address || null,
    "schedules[].startDate": camp.schedules[0]?.startDate ?? null,
    "schedules[].endDate": camp.schedules[0]?.endDate ?? null,
    "ageGroups[].minAge": camp.ageGroups[0]?.minAge ?? null,
    "ageGroups[].maxAge": camp.ageGroups[0]?.maxAge ?? null,
    "pricing[].amount": camp.pricing[0]?.amount ?? null,
  };
  return out;
}

/** Reduce traverse proposals to first-value-per-field for comparison. */
function traverseFields(proposals: ExtractionProposal[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of proposals) {
    if (!(p.fieldPath in out)) out[p.fieldPath] = p.candidateValue;
  }
  return out;
}

function sameish(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "";
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("NOT_VERIFIED: ANTHROPIC_API_KEY is not set — the live parity harness was not run.");
    console.log("To run it:");
    console.log("  1. export ANTHROPIC_API_KEY=sk-ant-...   (or add it to .env.local)");
    console.log("  2. npm run traverse:parity");
    console.log(`  3. Read the report at ${path.relative(process.cwd(), ARTIFACT_ROOT)}/<timestamp>/report.md`);
    process.exit(0);
  }

  const provider = createAnthropicExtractionProvider({ model: process.env.TRAVERSE_MODEL || undefined });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(ARTIFACT_ROOT, stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const report: Record<string, unknown>[] = [];
  const mdLines: string[] = [`# Traverse parity report`, ``, `Generated: ${new Date().toISOString()}`, ``];

  for (const src of SOURCES) {
    const url = src.scraper.entryUrl;
    console.log(`\n=== ${src.key} (${url}) ===`);
    let html = "";
    let legacyCamps: CampInput[] = [];
    let legacyErr: string | null = null;
    try {
      html = await fetchHtml(url);
      const result = await src.scraper.run();
      legacyCamps = result.camps;
      legacyErr = result.errors[0] ?? null;
    } catch (e) {
      legacyErr = e instanceof Error ? e.message : String(e);
    }

    let traverseProposals: ExtractionProposal[] = [];
    let traverseErr: string | null = null;
    let traverseWarnings: string[] = [];
    if (html) {
      const tr = await runTraverseExtraction({ content: html, sourceRef: url, provider });
      traverseProposals = tr.proposals;
      traverseErr = tr.error ?? null;
      traverseWarnings = tr.warnings ?? [];
    } else {
      traverseErr = "no HTML fetched (legacy fetch failed)";
    }

    const legacy = legacyFields(legacyCamps[0]);
    const trav = traverseFields(traverseProposals);

    const allFields = new Set<string>([...Object.keys(legacy), ...Object.keys(trav)]);
    const agreement: Record<string, { legacy: unknown; traverse: unknown; agree: boolean }> = {};
    const traverseOnly: string[] = [];
    const selectorOnly: string[] = [];
    for (const f of allFields) {
      const hasLegacy = legacy[f] !== null && legacy[f] !== undefined && legacy[f] !== "";
      const hasTrav = trav[f] !== null && trav[f] !== undefined && trav[f] !== "";
      if (hasLegacy && hasTrav) {
        agreement[f] = { legacy: legacy[f], traverse: trav[f], agree: sameish(legacy[f], trav[f]) };
      } else if (hasTrav && !hasLegacy) {
        traverseOnly.push(f);
      } else if (hasLegacy && !hasTrav) {
        selectorOnly.push(f);
      }
    }

    const confidences = traverseProposals.map((p) => p.confidence);
    const confDist = {
      count: confidences.length,
      min: confidences.length ? Math.min(...confidences) : null,
      max: confidences.length ? Math.max(...confidences) : null,
      mean: confidences.length ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100 : null,
      buckets: {
        "0.0-0.5": confidences.filter((c) => c < 0.5).length,
        "0.5-0.8": confidences.filter((c) => c >= 0.5 && c < 0.8).length,
        "0.8-1.0": confidences.filter((c) => c >= 0.8).length,
      },
    };

    const agreeCount = Object.values(agreement).filter((a) => a.agree).length;
    const srcReport = {
      source: src.key,
      url,
      legacyCampCount: legacyCamps.length,
      legacyError: legacyErr,
      traverseProposalCount: traverseProposals.length,
      traverseError: traverseErr,
      traverseWarnings,
      fieldsCompared: Object.keys(agreement).length,
      fieldsAgreed: agreeCount,
      agreement,
      traverseOnly,
      selectorOnly,
      confidenceDistribution: confDist,
      scalarSchemaPaths: SCALAR_SCHEMA_PATHS,
    };
    report.push(srcReport);

    mdLines.push(`## ${src.key}`);
    mdLines.push(`- URL: ${url}`);
    mdLines.push(`- Legacy scraper: ${legacyCamps.length} camps${legacyErr ? ` (error: ${legacyErr})` : ""}`);
    mdLines.push(`- Traverse: ${traverseProposals.length} proposals${traverseErr ? ` (error: ${traverseErr})` : ""}`);
    mdLines.push(`- Fields compared: ${Object.keys(agreement).length}, agreed: ${agreeCount}`);
    mdLines.push(`- Traverse-only finds: ${traverseOnly.join(", ") || "(none)"}`);
    mdLines.push(`- Selector-only finds: ${selectorOnly.join(", ") || "(none)"}`);
    mdLines.push(`- Confidence: mean ${confDist.mean}, buckets ${JSON.stringify(confDist.buckets)}`);
    if (traverseWarnings.length) mdLines.push(`- Traverse warnings: ${traverseWarnings.length}`);
    mdLines.push("");

    console.log(`legacy=${legacyCamps.length} camps, traverse=${traverseProposals.length} proposals, agreed ${agreeCount}/${Object.keys(agreement).length}, traverse-only=[${traverseOnly.join(",")}]`);
  }

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "report.md"), mdLines.join("\n"));
  console.log(`\n✓ Parity report written to ${path.relative(process.cwd(), outDir)}/`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
