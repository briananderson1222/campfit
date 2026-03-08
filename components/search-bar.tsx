"use client";

import { Search, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onFilterToggle?: () => void;
  placeholder?: string;
  size?: "lg" | "md";
}

export function SearchBar({
  value,
  onChange,
  onFilterToggle,
  placeholder = "Search camps by name, activity, or neighborhood...",
  size = "md",
}: SearchBarProps) {
  return (
    <div className="relative group">
      <div
        className={cn(
          "absolute inset-0 rounded-2xl bg-pine-400/10 blur-xl opacity-0 group-focus-within:opacity-100 transition-opacity duration-300",
          size === "lg" && "rounded-3xl"
        )}
      />
      <div className="relative flex items-center">
        <Search
          className={cn(
            "absolute left-4 text-bark-300 group-focus-within:text-pine-500 transition-colors",
            size === "lg" ? "w-5 h-5" : "w-4 h-4"
          )}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn(
            "input-field pr-12",
            size === "lg"
              ? "pl-12 py-4 text-base rounded-3xl shadow-camp"
              : "pl-10 py-3 text-sm"
          )}
        />
        {onFilterToggle && (
          <button
            onClick={onFilterToggle}
            className={cn(
              "absolute right-3 p-2 rounded-xl hover:bg-cream-200 transition-colors",
              "text-bark-300 hover:text-bark-500"
            )}
            title="Toggle filters"
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
