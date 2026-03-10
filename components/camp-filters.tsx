"use client";

import { X } from "lucide-react";
import {
  CampCategory,
  CampType,
  CATEGORY_LABELS,
  CAMP_TYPE_LABELS,
  CAMP_TYPE_DESCRIPTIONS,
  NEIGHBORHOODS,
  SUMMER_WEEKS,
  CampFilters,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface CampFiltersProps {
  filters: CampFilters;
  onFiltersChange: (filters: CampFilters) => void;
  onClose?: () => void;
  show: boolean;
}

const AGE_RANGES = [
  { label: "PreK (3-4)", minAge: 3, maxAge: 4 },
  { label: "K-2nd (5-8)", minAge: 5, maxAge: 8 },
  { label: "3rd-5th (8-11)", minAge: 8, maxAge: 11 },
  { label: "6th-8th (11-14)", minAge: 11, maxAge: 14 },
  { label: "9th+ (14-18)", minAge: 14, maxAge: 18 },
];

const COST_RANGES = [
  { label: "Under $200", max: 200 },
  { label: "Under $300", max: 300 },
  { label: "Under $500", max: 500 },
  { label: "Any price", max: undefined },
];

export function CampFiltersPanel({
  filters,
  onFiltersChange,
  onClose,
  show,
}: CampFiltersProps) {
  if (!show) return null;

  const update = (partial: Partial<CampFilters>) => {
    onFiltersChange({ ...filters, ...partial });
  };

  const clearAll = () => onFiltersChange({});

  const activeCount = Object.values(filters).filter(
    (v) => v !== undefined && v !== ""
  ).length;

  return (
    <div className="glass-panel p-5 sm:p-6 animate-fade-up">
      <div className="flex items-center justify-between mb-5">
        <h3 className="font-display font-bold text-bark-700 text-lg">
          Filters
          {activeCount > 0 && (
            <span className="ml-2 text-sm font-normal text-bark-300">
              ({activeCount} active)
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          {activeCount > 0 && (
            <button
              onClick={clearAll}
              className="text-sm text-terracotta-400 hover:text-terracotta-500 font-medium transition-colors"
            >
              Clear all
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-cream-200 transition-colors"
            >
              <X className="w-4 h-4 text-bark-400" />
            </button>
          )}
        </div>
      </div>

      <div className="space-y-5">
        {/* Category */}
        <FilterSection title="Category">
          <div className="flex flex-wrap gap-2">
            {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
              <button
                key={key}
                onClick={() =>
                  update({
                    category:
                      filters.category === key
                        ? undefined
                        : (key as CampCategory),
                  })
                }
                className={cn(
                  "filter-chip",
                  filters.category === key
                    ? "filter-chip-active"
                    : "filter-chip-inactive"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </FilterSection>

        {/* Camp Type */}
        <FilterSection title="Camp Type">
          <div className="flex flex-wrap gap-2">
            {Object.entries(CAMP_TYPE_LABELS).map(([key, label]) => (
              <button
                key={key}
                title={CAMP_TYPE_DESCRIPTIONS[key as CampType]}
                onClick={() =>
                  update({
                    campType:
                      filters.campType === key
                        ? undefined
                        : (key as CampType),
                  })
                }
                className={cn(
                  "filter-chip",
                  filters.campType === key
                    ? "filter-chip-active"
                    : "filter-chip-inactive"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-bark-300 mt-2">Hover a type for details.</p>
        </FilterSection>

        {/* Age Range */}
        <FilterSection title="Age Group">
          <div className="flex flex-wrap gap-2">
            {AGE_RANGES.map((range) => (
              <button
                key={range.label}
                onClick={() =>
                  update({
                    minAge:
                      filters.minAge === range.minAge
                        ? undefined
                        : range.minAge,
                    maxAge:
                      filters.maxAge === range.maxAge
                        ? undefined
                        : range.maxAge,
                  })
                }
                className={cn(
                  "filter-chip",
                  filters.minAge === range.minAge &&
                    filters.maxAge === range.maxAge
                    ? "filter-chip-active"
                    : "filter-chip-inactive"
                )}
              >
                {range.label}
              </button>
            ))}
          </div>
        </FilterSection>

        {/* Neighborhood */}
        <FilterSection title="Neighborhood">
          <div className="flex flex-wrap gap-2">
            {NEIGHBORHOODS.slice(0, 8).map((hood) => (
              <button
                key={hood}
                onClick={() =>
                  update({
                    neighborhood:
                      filters.neighborhood === hood ? undefined : hood,
                  })
                }
                className={cn(
                  "filter-chip",
                  filters.neighborhood === hood
                    ? "filter-chip-active"
                    : "filter-chip-inactive"
                )}
              >
                {hood}
              </button>
            ))}
          </div>
        </FilterSection>

        {/* Cost */}
        <FilterSection title="Max Cost per Week">
          <div className="flex flex-wrap gap-2">
            {COST_RANGES.map((range) => (
              <button
                key={range.label}
                onClick={() =>
                  update({
                    maxCost:
                      filters.maxCost === range.max ? undefined : range.max,
                  })
                }
                className={cn(
                  "filter-chip",
                  filters.maxCost === range.max
                    ? "filter-chip-active"
                    : "filter-chip-inactive"
                )}
              >
                {range.label}
              </button>
            ))}
          </div>
        </FilterSection>

        {/* Week */}
        <FilterSection title="Available Week">
          <div className="flex flex-wrap gap-2">
            {SUMMER_WEEKS.map((week) => (
              <button
                key={week.start}
                onClick={() =>
                  update({
                    week: filters.week === week.start ? undefined : week.start,
                  })
                }
                className={cn(
                  "filter-chip text-xs",
                  filters.week === week.start
                    ? "filter-chip-active"
                    : "filter-chip-inactive"
                )}
              >
                {week.label}
              </button>
            ))}
          </div>
        </FilterSection>
      </div>
    </div>
  );
}

function FilterSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-bark-400 uppercase tracking-wider mb-2.5">
        {title}
      </h4>
      {children}
    </div>
  );
}
