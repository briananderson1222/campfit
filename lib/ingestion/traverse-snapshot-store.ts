/**
 * traverse-snapshot-store.ts — the shared snapshot store + fetch identity for
 * the traverse fetch/capture path (@kontourai/traverse@^0.3.0, Slice 2b).
 *
 * Every LIVE traverse extraction (the parity harness and the flagged ingestion
 * path) fetches through `@kontourai/traverse/fetch`'s `fetchAndExtract` in
 * `live-with-capture` mode, persisting the exact bytes it extracted from into
 * this store. That makes each proposal traceable to a byte-identical snapshot
 * (via the `traverse-snapshot:<id>?...sha256=<hash>` sourceRef) and lets a
 * future parity/adjudication run REPLAY the same page with no network.
 *
 * Location: `.kontourai/campfit/snapshots/` — under the repo's already
 * gitignored `.kontourai/` runtime-state prefix (see .gitignore), so captured
 * pages never enter version control and CI stays network-free (CI uses the
 * REPLAY path / stub provider and never calls fetchSource).
 */

import * as path from "node:path";
import { createFilesystemSnapshotStore } from "@kontourai/traverse/fetch";
import type { SnapshotStore } from "@kontourai/traverse/fetch";

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

/** Build the filesystem snapshot store CampFit's traverse fetch path writes to. */
export function createCampfitSnapshotStore(root: string = SNAPSHOT_STORE_ROOT): SnapshotStore {
  return createFilesystemSnapshotStore({ root });
}
