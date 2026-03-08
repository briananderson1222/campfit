"use client";

import { useState, useMemo } from "react";
import { CalendarDays, Filter } from "lucide-react";
import { WeekCalendar } from "@/components/week-calendar";
import { MOCK_CAMPS } from "@/lib/mock-data";
import {
  CampCategory,
  CampType,
  CATEGORY_LABELS,
  CAMP_TYPE_LABELS,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const AGE_FILTERS = [
  { label: "All Ages", min: 0, max: 99 },
  { label: "PreK-K (3-6)", min: 3, max: 6 },
  { label: "Elem (6-11)", min: 6, max: 11 },
  { label: "Middle (11-14)", min: 11, max: 14 },
  { label: "Teen (14-18)", min: 14, max: 18 },
];

export default function CalendarPage() {
  const [selectedCategory, setSelectedCategory] = useState<
    CampCategory | "ALL"
  >("ALL");
  const [selectedAge, setSelectedAge] = useState(AGE_FILTERS[0]);
  const [selectedType, setSelectedType] = useState<CampType | "ALL">("ALL");

  const filteredCamps = useMemo(() => {
    return MOCK_CAMPS.filter((camp) => {
      if (selectedCategory !== "ALL" && camp.category !== selectedCategory)
        return false;

      if (selectedType !== "ALL" && camp.campType !== selectedType)
        return false;

      if (selectedAge.min > 0 || selectedAge.max < 99) {
        const hasOverlap = camp.ageGroups.some((ag) => {
          const campMin = ag.minAge ?? 0;
          const campMax = ag.maxAge ?? 99;
          return campMin <= selectedAge.max && campMax >= selectedAge.min;
        });
        if (!hasOverlap) return false;
      }

      return true;
    });
  }, [selectedCategory, selectedAge, selectedType]);

  const categories: [string, string][] = [
    ["ALL", "All Categories"],
    ...Object.entries(CATEGORY_LABELS).filter(([key]) =>
      MOCK_CAMPS.some((c) => c.category === key)
    ),
  ];

  const campTypes: [string, string][] = [
    ["ALL", "All Types"],
    ...Object.entries(CAMP_TYPE_LABELS).filter(([key]) =>
      MOCK_CAMPS.some((c) => c.campType === key)
    ),
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
      {/* Header */}
      <div className="mb-8 animate-fade-up">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-2xl bg-pine-600 flex items-center justify-center">
            <CalendarDays className="w-5 h-5 text-cream-100" />
          </div>
          <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-bark-700 tracking-tight">
            Summer 2026 Calendar
          </h1>
        </div>
        <p className="text-bark-400 ml-[52px]">
          See which camps are running each week at a glance
        </p>
      </div>

      {/* Filters */}
      <div className="glass-panel p-5 mb-8 animate-fade-up stagger-1">
        <div className="flex items-center gap-2 mb-4 text-bark-400">
          <Filter className="w-4 h-4" />
          <span className="text-sm font-medium">Filter camps</span>
        </div>

        <div className="space-y-4">
          {/* Category filter */}
          <div>
            <label className="text-xs font-semibold text-bark-400 uppercase tracking-wider mb-2 block">
              Category
            </label>
            <div className="flex flex-wrap gap-2">
              {categories.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() =>
                    setSelectedCategory(key as CampCategory | "ALL")
                  }
                  className={cn(
                    "filter-chip text-xs",
                    selectedCategory === key
                      ? "filter-chip-active"
                      : "filter-chip-inactive"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Type + Age row */}
          <div className="flex flex-wrap gap-6">
            <div>
              <label className="text-xs font-semibold text-bark-400 uppercase tracking-wider mb-2 block">
                Camp Type
              </label>
              <div className="flex flex-wrap gap-2">
                {campTypes.map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setSelectedType(key as CampType | "ALL")}
                    className={cn(
                      "filter-chip text-xs",
                      selectedType === key
                        ? "filter-chip-active"
                        : "filter-chip-inactive"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-bark-400 uppercase tracking-wider mb-2 block">
                Age Group
              </label>
              <div className="flex flex-wrap gap-2">
                {AGE_FILTERS.map((age) => (
                  <button
                    key={age.label}
                    onClick={() => setSelectedAge(age)}
                    className={cn(
                      "filter-chip text-xs",
                      selectedAge.label === age.label
                        ? "filter-chip-active"
                        : "filter-chip-inactive"
                    )}
                  >
                    {age.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 mb-4 text-xs text-bark-300 animate-fade-up stagger-2">
        <span className="font-semibold uppercase tracking-wider">Legend:</span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-3 rounded bg-terracotta-400/70" />
          Sports
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-3 rounded bg-amber-300/70" />
          Arts
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-3 rounded bg-sky-400/70" />
          STEM
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-3 rounded bg-pine-500/70" />
          Nature
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-3 rounded bg-rose-500/70" />
          Theater
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-3 rounded bg-orange-400/70" />
          Cooking
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-3 rounded bg-pine-300/70" />
          Multi-Activity
        </span>
      </div>

      {/* Calendar */}
      <div className="glass-panel p-4 sm:p-6 animate-fade-up stagger-3">
        {filteredCamps.length === 0 ? (
          <div className="text-center py-16 text-bark-300">
            <CalendarDays className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-display font-semibold text-bark-400">
              No camps match your filters
            </p>
            <p className="text-sm mt-1">Try broadening your search</p>
          </div>
        ) : (
          <WeekCalendar camps={filteredCamps} />
        )}
      </div>

      <p className="text-center text-xs text-bark-300 mt-6">
        Showing {filteredCamps.length} of {MOCK_CAMPS.length} camps
      </p>
    </div>
  );
}
