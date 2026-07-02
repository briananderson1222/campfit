/**
 * traverse-parity.ts — LIVE parity harness for the @kontourai/traverse pilot
 * (Slice 1b). NOT part of CI. Runs BOTH the legacy selector scraper AND
 * schema-directed traverse extraction (real Anthropic-compatible provider)
 * over the SAME freshly-fetched pages, then writes a parity report to a
 * local artifacts dir.
 *
 *   npm run traverse:parity
 *
 * The provider is resolved via `@kontourai/datum@^0.2.0`
 * (`lib/ingestion/resolve-extraction-provider.ts`) from the `extraction-default`
 * role in `.datum/config.json` (committed — see that file for the `zai` /
 * `anthropic` providers). Requires the referenced key to be exported (e.g.
 * `ZAI_API_KEY` for the default `glm-5.2@zai` role). If resolution fails —
 * no key set, unknown role, etc. — the harness prints NOT_VERIFIED with exact
 * run instructions and exits 0; it never fabricates a report.
 *
 * Overrides, highest precedence first:
 *   - `TRAVERSE_ROLE`       — resolve a different datum ref/role entirely
 *     (e.g. `TRAVERSE_ROLE=anthropic-default` to run against Anthropic
 *     directly instead of the default Z.AI role).
 *   - `DATUM_ROLE_<ROLE>`   — datum-native escape hatch: override what a role
 *     points at without touching `.datum/config.json` (see datum's README).
 *   - `TRAVERSE_MODEL` / `ANTHROPIC_BASE_URL` — explicit, final overrides on
 *     top of whatever datum resolves (kept for one-off pins; datum-native
 *     mechanisms above are preferred for anything more than that).
 *
 * The report captures, per source:
 *   - which traverse provider (name, incl. "@<host>" for a custom baseUrl),
 *     the datum ref/provider it resolved from, and which model (from the
 *     provider's raw response) produced the run
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
import { resolveExtractionProvider } from "@/lib/ingestion/resolve-extraction-provider";
import type { ExtractionProposal } from "@kontourai/traverse";
import { DatumError } from "@kontourai/datum";

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
  let resolution: ReturnType<typeof resolveExtractionProvider>;
  try {
    resolution = resolveExtractionProvider();
  } catch (err) {
    if (err instanceof DatumError) {
      console.log(`NOT_VERIFIED: datum could not resolve an extraction provider (${err.code}): ${err.message}`);
      console.log("To run it:");
      console.log("  1. export ZAI_API_KEY=...   (the key for the extraction-default role in .datum/config.json;");
      console.log("     or add it to .env.local)");
      console.log("  2. Preflight check: npx datum doctor --probe");
      console.log("  3. npm run traverse:parity");
      console.log(`  4. Read the report at ${path.relative(process.cwd(), ARTIFACT_ROOT)}/<timestamp>/report.md`);
      process.exit(0);
    }
    throw err;
  }

  const { provider, ref, datumProvider, model: resolvedModelId, baseUrl: resolvedBaseUrl } = resolution;
  console.log(
    `Traverse provider: ${provider.name} (datum ref: "${ref}" -> ${datumProvider}, model: ${resolvedModelId}` +
      `${resolvedBaseUrl ? `, baseUrl: ${resolvedBaseUrl}` : ""})`
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(ARTIFACT_ROOT, stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const report: Record<string, unknown>[] = [];
  const mdLines: string[] = [
    `# Traverse parity report`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    `Traverse provider: ${provider.name} (datum ref: "${ref}" -> ${datumProvider}, model: ${resolvedModelId})`,
    ``,
  ];

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
    let traverseModel: string | null = null;
    if (html) {
      const tr = await runTraverseExtraction({ content: html, sourceRef: url, provider });
      traverseProposals = tr.proposals;
      traverseErr = tr.error ?? null;
      traverseWarnings = tr.warnings ?? [];
      traverseModel = tr.raw?.model ?? null;
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
      // Which backend + model produced the traverse side of this comparison —
      // providerName carries the "@<host>" suffix when ANTHROPIC_BASE_URL/opts.baseUrl
      // points at a non-default (e.g. Z.AI) endpoint; traverseModel is the model
      // the provider's raw response actually reports (may differ from
      // TRAVERSE_MODEL if the backend remaps model names, e.g. Z.AI -> GLM).
      // datumRef/datumProvider record which @kontourai/datum role/provider the
      // extraction-side credentials and model were resolved from.
      traverseProviderName: provider.name,
      traverseModel,
      datumRef: ref,
      datumProvider,
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
    mdLines.push(`- Traverse provider: ${provider.name}${traverseModel ? ` (model: ${traverseModel})` : ""}`);
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
