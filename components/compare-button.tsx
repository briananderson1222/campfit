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
        "flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-all",
        active
          ? "bg-pine-100 text-pine-600 border border-pine-300/60"
          : "bg-cream-200/60 text-bark-400 border border-transparent hover:bg-cream-200 hover:text-bark-600",
        atMax && "opacity-40 cursor-not-allowed",
        className
      )}
    >
      <GitCompareArrows className="w-3.5 h-3.5" />
      {active ? "Comparing" : "Compare"}
    </button>
  );
}
