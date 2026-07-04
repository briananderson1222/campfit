/**
 * lib/ingestion/discovery/sources/denver-rec-centers.ts — the shipped discovery
 * source (I22 / #52): a curated seed of Denver-metro rec-center / municipal /
 * school-district program providers.
 *
 * This is the "curated seed query" flavor named in the issue's thinnest slice.
 * The seed lives in data/discovery/denver-rec-centers.json so the list is data,
 * not code, and can grow without a code change. `discover()` reads the file and
 * stamps a single retrievedAt for the run — deterministic and key-free, so the
 * discovery job is reproducible in CI with no network or model dependency.
 *
 * A live-page source (e.g. a rec-center program-listing SPA that must be
 * fetched and extracted — issue I23) implements the same DiscoverySource
 * interface and can run the traverse pipeline inside its own `discover()`;
 * everything downstream (metro filter, dedupe, queue) is unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DiscoverySource,
  DiscoverySourceResult,
  RawProviderCandidate,
} from "../types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.resolve(
  __dirname,
  "../../../../data/discovery/denver-rec-centers.json",
);

interface SeedFile {
  query: string;
  candidates: Array<{
    name: string;
    websiteUrl?: string | null;
    city?: string | null;
    neighborhood?: string | null;
  }>;
}

function readSeed(): SeedFile {
  const raw = fs.readFileSync(SEED_PATH, "utf8");
  const parsed = JSON.parse(raw) as SeedFile;
  if (!Array.isArray(parsed.candidates)) {
    throw new Error(
      `Discovery seed ${SEED_PATH} is missing a "candidates" array`,
    );
  }
  return parsed;
}

export const denverRecCenterSource: DiscoverySource = {
  key: "denver-rec-centers",
  label: "Denver Metro Rec-Center / Municipal Program Seed",
  communitySlug: "denver",

  async discover(): Promise<DiscoverySourceResult> {
    const seed = readSeed();
    const retrievedAt = new Date();
    const candidates: RawProviderCandidate[] = seed.candidates.map((entry) => ({
      name: entry.name.trim(),
      websiteUrl: entry.websiteUrl?.trim() || null,
      city: entry.city?.trim() || null,
      neighborhood: entry.neighborhood?.trim() || null,
    }));
    return {
      candidates,
      discoveryQuery: seed.query,
      retrievedAt,
    };
  },
};
