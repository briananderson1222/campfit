/**
 * tests/integration/surface-table-access-guard.test.ts — V11 guard (LOW,
 * security review SF3): admin emails are persisted into Surface*
 * (`SurfaceEvidence.collectedBy`/`SurfaceVerificationEvent.actor`/
 * `sourceRef`) tables, matching the pre-existing `FieldAttestation`/
 * `fieldSources` pattern. No parent-facing reader exists today — this is a
 * cheap, grep-based regression guard so a future parent-facing route/page
 * added under `app/` (outside `app/admin`/`app/api/admin`) is caught before
 * it exposes admin-identifying data by directly selecting from a `Surface*`
 * table, rather than relying on a human noticing during review.
 *
 * Deliberately grep-based (source text, not `import`/runtime introspection):
 * the point is to catch a literal `"SurfaceEvidence"` (etc.) SQL string
 * appearing in a parent-facing file, which a type-level check cannot see.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const appDir = path.join(repoRoot, "app");

const SURFACE_TABLE_NAMES = [
  "SurfaceClaimDefinition",
  "SurfaceEvidence",
  "SurfaceVerificationEvent",
  "SurfaceVerificationPolicy",
  "SurfaceClaimGroup",
];

/** Admin-only subtrees under `app/` — the only places allowed to reference Surface* tables. */
const ADMIN_SUBTREES = [path.join(appDir, "admin"), path.join(appDir, "api", "admin")];

function isAdminPath(filePath: string): boolean {
  return ADMIN_SUBTREES.some((adminDir) => filePath === adminDir || filePath.startsWith(adminDir + path.sep));
}

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("V11 guard: no parent-facing app/ module selects from Surface* tables (security review SF3)", () => {
  it("no file under app/ outside app/admin and app/api/admin references a Surface* table name", () => {
    const parentFacingFiles = listSourceFiles(appDir).filter((filePath) => !isAdminPath(filePath));
    expect(parentFacingFiles.length).toBeGreaterThan(0); // sanity: the scan itself isn't vacuous

    const offenders: { file: string; table: string }[] = [];
    for (const filePath of parentFacingFiles) {
      const contents = fs.readFileSync(filePath, "utf8");
      for (const table of SURFACE_TABLE_NAMES) {
        if (contents.includes(table)) {
          offenders.push({ file: path.relative(repoRoot, filePath), table });
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
