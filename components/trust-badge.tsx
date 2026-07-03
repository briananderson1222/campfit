"use client";

import { ShieldCheck, AlertTriangle } from "lucide-react";
import type { Camp } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isTrustDisplayEnabled, trustStatus } from "@/lib/trust";

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
}: {
  camp: TrustBadgeCamp;
  variant?: "badge" | "dot";
  className?: string;
}) {
  if (!isTrustDisplayEnabled()) return null;

  const status = trustStatus(camp);
  const Icon = status.verified ? ShieldCheck : AlertTriangle;

  if (variant === "dot") {
    return (
      <span
        className={cn("inline-flex items-center", className)}
        title={status.detail}
        aria-label={status.label}
        data-trust={status.verified ? "verified" : "unverified"}
      >
        <Icon
          className={cn(
            "w-3 h-3",
            status.verified ? "text-pine-500" : "text-amber-500",
          )}
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "badge gap-1 whitespace-nowrap",
        status.verified
          ? "bg-pine-50 text-pine-600 dark:bg-pine-400/15 dark:text-pine-300"
          : "bg-amber-50 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300",
        className,
      )}
      title={status.detail}
      data-trust={status.verified ? "verified" : "unverified"}
    >
      <Icon className="w-3 h-3" />
      {status.label}
    </span>
  );
}
