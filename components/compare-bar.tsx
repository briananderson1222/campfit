"use client";

import { useRouter } from "next/navigation";
import { GitCompareArrows, X } from "lucide-react";
import { useCompare } from "@/lib/compare-context";
import { cn } from "@/lib/utils";
import { useCommunity } from "@/lib/community-context";
import { routes } from "@/lib/routes";

export function CompareBar() {
  const { compareList, clearCompare } = useCompare();
  const router = useRouter();
  const { slug: communitySlug } = useCommunity();

  if (compareList.length === 0) return null;

  const handleCompare = () => {
    router.push(routes.communityCompare(communitySlug, compareList));
  };

  return (
    <div
      className={cn(
        "fixed bottom-4 left-1/2 -translate-x-1/2 z-50",
        "flex items-center gap-3 px-4 py-3 rounded-2xl shadow-2xl",
        "bg-bark-700 text-white border border-bark-600/50 backdrop-blur-sm",
        "animate-fade-up"
      )}
    >
      <GitCompareArrows className="w-4 h-4 text-pine-300 shrink-0" />
      <span className="text-sm font-medium">
        {compareList.length} camp{compareList.length !== 1 ? "s" : ""} selected
      </span>
      <div className="flex gap-1.5 ml-1">
        {compareList.map((_, i) => (
          <div
            key={i}
            className="w-2 h-2 rounded-full bg-pine-400"
          />
        ))}
        {Array.from({ length: 3 - compareList.length }).map((_, i) => (
          <div
            key={`empty-${i}`}
            className="w-2 h-2 rounded-full bg-bark-500 border border-bark-500"
          />
        ))}
      </div>
      <button
        onClick={handleCompare}
        className="ml-1 px-3 py-1.5 rounded-xl bg-pine-500 hover:bg-pine-400 text-white text-sm font-semibold transition-colors"
      >
        Compare
      </button>
      <button
        onClick={clearCompare}
        className="p-1 rounded-lg hover:bg-bark-600 text-bark-400 hover:text-white transition-colors"
        title="Clear selection"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
