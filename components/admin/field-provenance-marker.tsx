/**
 * components/admin/field-provenance-marker.tsx — R3 (campfit#91): renders an
 * explicit "no provenance" marker for a proposed-changes diff row when
 * neither `diff.excerpt` nor `diff.sourceUrl` is present.
 *
 * `review-panel.tsx`'s excerpt/source block (lines ~602-612, pre-R3) rendered
 * nothing at all when both were absent — a silent gap. This component
 * replaces that silent gap with a visible marker, reusing the same amber
 * `ShieldAlert` "no proof citation yet" visual idiom already established for
 * camp-level fields at `review-panel.tsx:332-334`, so the concept reads as
 * consistent rather than a new, bolted-on pattern.
 *
 * Display-only this slice: rendering this marker does not change
 * approve/reject behavior — a reviewer can still approve a provenance-less
 * field, same as before R3. See the plan's Stop-short risks for the
 * recorded (not deferred-by-omission) product decision.
 */
import { ShieldAlert } from 'lucide-react';

/**
 * Pure predicate mirroring the exact condition `review-panel.tsx` uses to
 * decide between the existing excerpt/source-link block and this marker.
 * Exported so it can be exercised directly by tests without needing to
 * render the full `ReviewPanel` client component (which pulls in
 * `next/navigation`'s `useRouter` and other app-router-only hooks that
 * aren't available under this repo's plain-Node Vitest environment).
 */
export function hasProvenance(diff: { excerpt?: string | null; sourceUrl?: string | null }): boolean {
  return Boolean(diff.excerpt || diff.sourceUrl);
}

export function FieldProvenanceMarker() {
  return (
    <div className="mt-3 flex items-start gap-2 bg-amber-50/60 border border-amber-200/60 rounded-lg px-3 py-2 dark:bg-amber-500/15 dark:border-amber-300/30">
      <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
      <p className="text-xs text-amber-800 italic leading-relaxed dark:text-amber-100">
        No provenance — this field has no excerpt or source link.
      </p>
    </div>
  );
}
