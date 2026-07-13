/**
 * traverse-snapshot-store.ts — the shared snapshot store + fetch identity for
 * the traverse fetch/capture path (@kontourai/traverse@^0.4.0).
 *
 * Every LIVE traverse extraction (the traverse pipeline and the cutover report
 * harness) fetches through `@kontourai/traverse/fetch`'s `fetchAndExtract` in
 * `live-with-capture` mode, persisting the exact bytes it extracted from into
 * this store. That makes each proposal traceable to a byte-identical snapshot
 * (via the `traverse-snapshot:<id>?...sha256=<hash>` sourceRef) and lets a
 * future parity/adjudication run REPLAY the same page with no network.
 *
 * Production uses the private `crawl-snapshots` Supabase Storage bucket when
 * service-role credentials are present. Local development without those
 * credentials keeps using `.kontourai/campfit/snapshots/`.
 */

import * as path from "node:path";
import { createFilesystemSnapshotStore } from "@kontourai/traverse/fetch";
import type { SnapshotStore } from "@kontourai/traverse/fetch";
import { createSupabaseSnapshotStore } from "@/lib/ingestion/supabase-snapshot-store";

/** Root dir for captured snapshots — gitignored under `.kontourai/`. */
export const SNAPSHOT_STORE_ROOT = path.join(
  process.cwd(),
  ".kontourai",
  "campfit",
  "snapshots"
);

/**
 * Honest, contactable fetch identity for CampFit's traverse fetch path. Robots
 * groups are matched against this UA's leading product token. Overrides the
 * traverse default (which ships a placeholder contact) with a real one.
 */
export const CAMPFIT_FETCH_USER_AGENT =
  "CampFitBot/1.0 (+https://campfit.app/bot; contact: hello@campfit.app)";

/**
 * Build CampFit's shared snapshot store. Production/service-role contexts use
 * durable Supabase Storage; environments without both credentials retain the
 * existing local filesystem behavior. The optional root remains effective for
 * filesystem callers and tests.
 */
export function createCampfitSnapshotStore(root: string = SNAPSHOT_STORE_ROOT): SnapshotStore {
  if (
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.NEXT_PUBLIC_SUPABASE_URL
  ) {
    return createSupabaseSnapshotStore();
  }
  return createFilesystemSnapshotStore({ root });
}
