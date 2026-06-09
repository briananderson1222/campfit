"use client";

import { GitCompareArrows } from "lucide-react";
import { useCompare } from "@/lib/compare-context";
import { cn } from "@/lib/utils";

interface CompareButtonProps {
  slug: string;
  className?: string;
}

export function CompareButton({ slug, className }: CompareButtonProps) {
  const { isComparing, toggleCompare, compareList } = useCompare();
  const active = isComparing(slug);
  const atMax = compareList.length >= 3 && !active;

  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!atMax) toggleCompare(slug);
      }}
      disabled={atMax}
      title={
        atMax
          ? "Max 3 camps can be compared at once"
          : active
            ? "Remove from comparison"
            : "Add to comparison"
      }
      className={cn(
        "compare-chip",
        active ? "compare-chip-active" : "compare-chip-inactive",
        atMax && "opacity-40 cursor-not-allowed",
        className
      )}
    >
      <GitCompareArrows className="w-3.5 h-3.5" />
      {active ? "Comparing" : "Compare"}
    </button>
  );
}
