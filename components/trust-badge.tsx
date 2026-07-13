"use client";

import { ShieldCheck, AlertTriangle, UserCheck, ShieldX } from "lucide-react";
import type { Camp } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isTrustDisplayEnabled } from "@/lib/trust";
import type { TrustDisplay } from "@/lib/admin/trust-display";

type TrustBadgeCamp = Pick<Camp, "dataConfidence" | "lastVerifiedAt">;

/**
 * The one component every public surface uses to render a camp's
 * verified/unverified status, so the distinction is identical everywhere
 * (R1/AC1) — no surface can drift into showing unverified data as if verified.
 *
 * Renders nothing when NEXT_PUBLIC_TRUST_DISPLAY is off (R5/AC5 rollback).
 *
 * variant:
 *   "badge" — full pill with label (cards, detail header, compare)
 *   "dot"   — icon-only marker for dense rows (calendar); label via title/aria
 *
 * `data-trust` ("verified" | "unverified") is emitted for automated sweeps.
 */
export function TrustBadge({
  camp,
  variant = "badge",
  className,
  display,
}: {
  camp: TrustBadgeCamp;
  variant?: "badge" | "dot";
  className?: string;
  /** Canonical ClaimStore projection, composed at a server read boundary. */
  display?: TrustDisplay;
}) {
  if (!isTrustDisplayEnabled()) return null;

  const status = display ?? {
    evidenceState: 'unverified' as const,
    trustOrigin: 'none' as const,
    label: 'Unverified',
    accessibleName: 'Unverified; no canonical evidence projection was supplied',
  };
  const verified = status.evidenceState === 'verified_current';
  const Icon = verified ? ShieldCheck : status.evidenceState === 'attested_no_source' ? UserCheck : status.evidenceState === 'stale_unresolvable' ? ShieldX : AlertTriangle;

  if (variant === "dot") {
    return (
      <span
        className={cn("inline-flex items-center", className)}
        title={status.accessibleName}
        aria-label={status.accessibleName}
        data-trust={verified ? "verified" : "unverified"}
        data-evidence-state={status.evidenceState}
        data-trust-origin={status.trustOrigin}
      >
        <Icon
          className={cn(
            "w-3 h-3",
            verified ? "text-pine-500" : "text-amber-500",
          )}
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "badge gap-1 whitespace-nowrap",
        verified
          ? "bg-pine-50 text-pine-600 dark:bg-pine-400/15 dark:text-pine-300"
          : "bg-amber-50 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300",
        className,
      )}
      title={status.accessibleName}
      aria-label={status.accessibleName}
      data-trust={verified ? "verified" : "unverified"}
      data-evidence-state={status.evidenceState}
      data-trust-origin={status.trustOrigin}
    >
      <Icon className="w-3 h-3" />
      {status.label}
    </span>
  );
}
