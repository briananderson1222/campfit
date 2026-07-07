/**
 * tests/integration/verification-authority-callers.test.ts — structural
 * tripwire for `recordEvidence`/`refreshCampVerificationCache`'s caller set
 * (campfit#51, Wave 4 Task 4.1, R4/AC4). No DB — a plain-text/AST-light
 * source scan (Node `fs`/`path`), following
 * `surface-table-access-guard.test.ts`'s "grep-based regression guard"
 * precedent: the point is to catch a literal new call site appearing
 * outside the allowed set, which a type-level check cannot see. Documented
 * as "a structural tripwire, not a formal proof," matching AC4's own
 * "code/behavior audit" framing.
 *
 * PLAN DEVIATION (flagged, not silently absorbed): the plan's AC4 wording
 * named the allowed caller set as "exactly {applyProposalReview,
 * applyBatchAcceptedClaims}" (both in `lib/admin/review-apply.ts`). A real
 * source scan (`grep -rn "recordEvidence(\|refreshCampVerificationCache("
 * app lib`, run during this task) shows TWO additional, PRE-EXISTING,
 * legitimately human-initiated callers the plan's wording did not account
 * for:
 *
 *   - `lib/admin/entity-admin-repository.ts`'s `recordCampAttestationEvidence`
 *     — the shared reconciliation path for `POST /api/admin/camps/[campId]/attest`
 *     (a human clicking "attest this field").
 *   - `lib/admin/bulk-attestation.ts`'s `bulkAttestCamp` — the shared path
 *     for `POST /api/admin/camps/[campId]` (`mark_verified` action) and the
 *     assistant tool's `mark_camp_verified` case (both human-initiated admin
 *     actions, per that module's own header comment).
 *
 * Both are pre-existing (verification-authority slice, before this task),
 * both are human-action-gated (an attestation route / admin mark-verified
 * action / assistant tool a human invokes), NEITHER is a background/cron
 * path — so R4's real invariant ("every path to verified state requires
 * human action or an audited batch action") already holds for them. Writing
 * this tripwire against the plan's literal (narrower) wording would
 * immediately fail against the current, correct codebase — so this test
 * asserts the ACTUAL closed allowlist of legitimate callers (all four
 * human/audited-batch paths), not the plan's incomplete literal set. Any
 * FIFTH caller added anywhere (e.g. a future cron/scheduled-crawl route)
 * still fails this test loudly.
 *
 * Documented manual grep (AC4's evidence expectation), run during this
 * task, confirming the scheduled-crawl cron route never calls either:
 *
 *   $ grep -rn "recordEvidence(\|refreshCampVerificationCache(" app lib
 *   lib/admin/entity-admin-repository.ts:219:    await recordEvidence(pool, { claim, evidence, event });
 *   lib/admin/entity-admin-repository.ts:222:  await refreshCampVerificationCache(args.campId);
 *   lib/admin/verification-authority.ts:536:export async function refreshCampVerificationCache(...
 *   lib/admin/review-apply.ts:<N>:      await refreshCampVerificationCache(proposal.campId);   [applyProposalReview]
 *   lib/admin/review-apply.ts:<N>:    await refreshCampVerificationCache(proposal.campId);      [applyBatchAcceptedFieldsForProposal]
 *   lib/admin/review-apply.ts:<N>:    await recordEvidence(pool, { claim: draft, ... });          [recordAppliedFieldEvidence]
 *   lib/admin/bulk-attestation.ts:<N>:    await recordEvidence(pool, { claim, evidence, event });
 *   lib/admin/bulk-attestation.ts:<N>:  const cacheResult = await refreshCampVerificationCache(campId, { now });
 *   lib/admin/claim-store.ts:890:export async function recordEvidence(...
 *
 *   `app/api/admin/crawl-schedule/**` and `app/api/cron/crawl/route.ts` /
 *   `app/api/cron/notify/route.ts` (the #92 scheduled-crawl surface): zero
 *   matches for either name — confirmed directly, not assumed.
 *
 * REVIEW M3 FIX: the file-level allowlist (`ALLOWED_CALLER_FILES`) only
 * catches a NEW FILE calling either target — a new FUNCTION added inside an
 * already-allowed file would pass it silently. Below, the SAME
 * function-level granularity `review-apply.ts` already got (the second
 * `it` block) is extended to `entity-admin-repository.ts` and
 * `bulk-attestation.ts`, pinning the exact allowed function name in each —
 * so a new function anywhere in those files that calls either target fails
 * loudly, matching this header's "closed allowlist" claim in practice, not
 * just at the file level.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const scanRoots = ['app', 'lib'].map((dir) => path.join(repoRoot, dir));

const TARGET_CALLS = ['recordEvidence(', 'refreshCampVerificationCache('];

/** The exact set of files allowed to contain a CALL (not the definition) of
 * either target. Any file outside this set containing a call fails the
 * test. See this file's header comment for why this set is four files, not
 * the plan's originally-stated two functions. */
const ALLOWED_CALLER_FILES = new Set([
  'lib/admin/review-apply.ts',
  'lib/admin/entity-admin-repository.ts',
  'lib/admin/bulk-attestation.ts',
]);

/** Definition-site lines (not calls) — excluded from the scan so the
 * function DECLARING `recordEvidence`/`refreshCampVerificationCache` is
 * never mistaken for a caller of itself. */
const DEFINITION_LINE_PATTERNS = [/function\s+recordEvidence\s*\(/, /function\s+refreshCampVerificationCache\s*\(/];

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

interface CallSite {
  file: string;
  line: number;
  target: string;
  text: string;
}

function findCallSites(): CallSite[] {
  const callSites: CallSite[] = [];
  for (const root of scanRoots) {
    for (const filePath of listSourceFiles(root)) {
      const relativePath = path.relative(repoRoot, filePath);
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      lines.forEach((lineText, index) => {
        const trimmed = lineText.trim();
        // Skip doc/line comments — a call name mentioned in prose (e.g. this
        // very module's own header comment) is not a call site. A REAL call
        // site is always executable code, never a line whose first
        // non-whitespace characters are a comment marker.
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        for (const target of TARGET_CALLS) {
          if (!lineText.includes(target)) continue;
          if (DEFINITION_LINE_PATTERNS.some((pattern) => pattern.test(lineText))) continue;
          callSites.push({ file: relativePath, line: index + 1, target, text: lineText.trim() });
        }
      });
    }
  }
  return callSites;
}

/** Nearest enclosing top-level function name for a call site within ONE
 * file — scans upward from the call line for the closest preceding
 * `[export] [async] function NAME(` declaration. Used only for the
 * fine-grained `review-apply.ts` assertion below (a file-level allowlist is
 * the primary, more refactor-resilient guard; this is a secondary,
 * documentation-grade check confirming the two known review-apply.ts paths
 * specifically). */
function enclosingFunctionName(fileLines: string[], callLineIndex: number): string | null {
  const declPattern = /^\s*(export\s+)?(async\s+)?function\s+(\w+)\s*\(/;
  for (let i = callLineIndex; i >= 0; i--) {
    const match = declPattern.exec(fileLines[i]!);
    if (match) return match[3]!;
  }
  return null;
}

describe('recordEvidence/refreshCampVerificationCache caller-set tripwire (R4/AC4)', () => {
  it('every call site lives in the allowed caller-file set — a new file calling either fails loudly', () => {
    const callSites = findCallSites();
    expect(callSites.length).toBeGreaterThan(0); // sanity: the scan itself isn't vacuous

    const offenders = callSites.filter((site) => !ALLOWED_CALLER_FILES.has(site.file));
    expect(offenders).toEqual([]);

    const filesWithCalls = new Set(callSites.map((site) => site.file));
    expect(filesWithCalls).toEqual(ALLOWED_CALLER_FILES);
  });

  it('review-apply.ts\'s call sites resolve to exactly the known interactive + batch helper functions', () => {
    const filePath = path.join(repoRoot, 'lib/admin/review-apply.ts');
    const fileLines = fs.readFileSync(filePath, 'utf8').split('\n');

    const callLineIndexes: number[] = [];
    fileLines.forEach((lineText, index) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      if (TARGET_CALLS.some((target) => lineText.includes(target)) && !DEFINITION_LINE_PATTERNS.some((p) => p.test(lineText))) {
        callLineIndexes.push(index);
      }
    });
    expect(callLineIndexes.length).toBeGreaterThan(0);

    const enclosingFunctions = new Set(
      callLineIndexes.map((index) => enclosingFunctionName(fileLines, index)),
    );

    // applyProposalReview: the interactive single-proposal path.
    // recordAppliedFieldEvidence / applyBatchAcceptedFieldsForProposal: the
    // batch path's private helpers (applyBatchAcceptedClaims itself
    // delegates to applyBatchAcceptedFieldsForProposal per proposal group —
    // see that function's own header comment).
    expect(enclosingFunctions).toEqual(new Set(['applyProposalReview', 'recordAppliedFieldEvidence', 'applyBatchAcceptedFieldsForProposal']));
  });

  /**
   * Review M3 (tripwire granularity): the file-level allowlist above stops
   * a FIFTH FILE from calling either target, but says nothing about a NEW
   * FUNCTION inside an already-allowed file quietly starting to call one —
   * that would pass the file-level check silently. Pin the exact enclosing
   * function name(s) per allowed file (mirroring the review-apply.ts
   * assertion just above), so a new function added to `entity-admin-repository.ts`
   * or `bulk-attestation.ts` that calls `recordEvidence`/
   * `refreshCampVerificationCache` fails this test loudly instead of
   * silently joining the caller set.
   */
  it.each([
    ['lib/admin/entity-admin-repository.ts', ['recordCampAttestationEvidence']],
    ['lib/admin/bulk-attestation.ts', ['bulkAttestCamp']],
  ] as const)('%s\'s call sites resolve to exactly %j', (relativePath, expectedFunctions) => {
    const filePath = path.join(repoRoot, relativePath);
    const fileLines = fs.readFileSync(filePath, 'utf8').split('\n');

    const callLineIndexes: number[] = [];
    fileLines.forEach((lineText, index) => {
      const trimmed = lineText.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      if (TARGET_CALLS.some((target) => lineText.includes(target)) && !DEFINITION_LINE_PATTERNS.some((p) => p.test(lineText))) {
        callLineIndexes.push(index);
      }
    });
    expect(callLineIndexes.length).toBeGreaterThan(0);

    const enclosingFunctions = new Set(
      callLineIndexes.map((index) => enclosingFunctionName(fileLines, index)),
    );

    expect(enclosingFunctions).toEqual(new Set(expectedFunctions));
  });

  it('the #92 scheduled-crawl cron surface never calls either (documented manual grep, re-verified programmatically)', () => {
    const cronPaths = [
      path.join(repoRoot, 'app/api/cron/crawl/route.ts'),
      path.join(repoRoot, 'app/api/cron/notify/route.ts'),
    ];
    const crawlScheduleDir = path.join(repoRoot, 'app/api/admin/crawl-schedule');
    const filesToCheck = [...cronPaths, ...(fs.existsSync(crawlScheduleDir) ? listSourceFiles(crawlScheduleDir) : [])];

    for (const filePath of filesToCheck) {
      if (!fs.existsSync(filePath)) continue;
      const contents = fs.readFileSync(filePath, 'utf8');
      for (const target of TARGET_CALLS) {
        expect(contents.includes(target)).toBe(false);
      }
    }
  });
});
