"use client";

import { useState, useMemo } from "react";
import {
  Sparkles,
  Mountain,
  TreePine,
  Sun,
  ArrowRight,
} from "lucide-react";
import { CampCard } from "@/components/camp-card";
import { SearchBar } from "@/components/search-bar";
import { CampFiltersPanel } from "@/components/camp-filters";
import { MOCK_CAMPS } from "@/lib/mock-data";
import {
  CampCategory,
  CampFilters,
  CATEGORY_LABELS,
  CATEGORY_COLORS,
} from "@/lib/types";
import { cn, getLowestPrice } from "@/lib/utils";
import Link from "next/link";

const CATEGORY_ICONS: Partial<Record<CampCategory, string>> = {
  SPORTS: "\\u26BD",
  ARTS: "\\uD83C\\uDFA8",
  STEM: "\\uD83E\\uDD16",
  NATURE: "\\uD83C\\uDF32",
  MUSIC: "\\uD83C\\uDFB5",
  THEATER: "\\uD83C\\uDFAD",
  COOKING: "\\uD83C\\uDF73",
  MULTI_ACTIVITY: "\\u2B50",
};

export default function HomePage() {
  const [query, setQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<CampFilters>({});

  const filteredCamps = useMemo(() => {
    return MOCK_CAMPS.filter((camp) => {
      if (query) {
        const q = query.toLowerCase();
        const searchable = [
          camp.name,
          camp.description,
          camp.neighborhood,
          camp.category,
        ]
          .join(" ")
          .toLowerCase();
        if (!searchable.includes(q)) return false;
      }

      if (filters.category && camp.category !== filters.category) return false;

      if (filters.campType && camp.campType !== filters.campType) return false;

      if (filters.neighborhood && camp.neighborhood !== filters.neighborhood)
        return false;

      if (filters.minAge || filters.maxAge) {
        const campAges = camp.ageGroups;
        const hasOverlap = campAges.some((ag) => {
          const campMin = ag.minAge ?? 0;
          const campMax = ag.maxAge ?? 99;
          return campMin <= (filters.maxAge ?? 99) && campMax >= (filters.minAge ?? 0);
        });
        if (!hasOverlap) return false;
      }

      if (filters.maxCost) {
        const lowestPrice = getLowestPrice(camp.pricing);
        if (lowestPrice !== null && lowestPrice > filters.maxCost) return false;
      }

      if (filters.week) {
        const hasWeek = camp.schedules.some((s) => s.startDate === filters.week);
        if (!hasWeek) return false;
      }

      return true;
    });
  }, [query, filters]);

  const comingSoonCamps = MOCK_CAMPS.filter(
    (c) => c.registrationStatus === "COMING_SOON"
  );

  const categories = Object.entries(CATEGORY_LABELS).filter(([key]) =>
    MOCK_CAMPS.some((c) => c.category === key)
  );

  return (
    <div>
      {/* Hero Section */}
      <section className="relative overflow-hidden">
        {/* Background decorations */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-20 -right-20 w-96 h-96 bg-pine-200/20 rounded-full blur-3xl" />
          <div className="absolute top-40 -left-32 w-72 h-72 bg-amber-300/15 rounded-full blur-3xl" />
          <Mountain className="absolute bottom-0 right-10 w-64 h-64 text-pine-600/[0.04]" />
          <TreePine className="absolute bottom-4 right-64 w-32 h-32 text-pine-600/[0.04]" />
          <Sun className="absolute top-8 right-32 w-16 h-16 text-amber-300/20 animate-float" />
        </div>

        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 pt-16 sm:pt-24 pb-12 sm:pb-16">
          <div className="max-w-2xl mx-auto text-center mb-10">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-pine-100/60 border border-pine-200/60 text-pine-600 text-sm font-medium mb-6 animate-fade-in">
              <Sparkles className="w-4 h-4" />
              Denver Summer 2026 camps are live
            </div>

            <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-extrabold text-bark-700 tracking-tight mb-5 text-balance animate-fade-up">
              Find the perfect camp for your{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-pine-500 to-pine-400">
                little explorer
              </span>
            </h1>

            <p className="text-lg text-bark-400 leading-relaxed max-w-lg mx-auto mb-8 animate-fade-up stagger-1">
              Search {MOCK_CAMPS.length * 40}+ Denver camps by age, activity,
              neighborhood, and availability. Never miss registration again.
            </p>

            {/* Search */}
            <div className="max-w-xl mx-auto animate-fade-up stagger-2">
              <SearchBar
                value={query}
                onChange={setQuery}
                onFilterToggle={() => setShowFilters(!showFilters)}
                size="lg"
              />
            </div>
          </div>

          {/* Category pills */}
          <div className="flex flex-wrap justify-center gap-2 animate-fade-up stagger-3">
            {categories.map(([key, label]) => (
              <button
                key={key}
                onClick={() =>
                  setFilters((f) => ({
                    ...f,
                    category:
                      f.category === key ? undefined : (key as CampCategory),
                  }))
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
        </div>
      </section>

      {/* Filters panel */}
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <CampFiltersPanel
          filters={filters}
          onFiltersChange={setFilters}
          onClose={() => setShowFilters(false)}
          show={showFilters}
        />
      </div>

      {/* Registration opening soon */}
      {comingSoonCamps.length > 0 && !query && !Object.keys(filters).length && (
        <section className="mx-auto max-w-7xl px-4 sm:px-6 mt-12">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="section-heading flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-300 animate-pulse" />
                Registration Opening Soon
              </h2>
              <p className="text-sm text-bark-300 mt-1">
                Set up alerts so you don&apos;t miss the window
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {comingSoonCamps.map((camp, i) => (
              <div
                key={camp.id}
                className="animate-fade-up"
                style={{ animationDelay: `${i * 0.1}s` }}
              >
                <CampCard camp={camp} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* All Camps */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 mt-16 pb-12">
        <div className="flex items-center justify-between mb-6">
          <h2 className="section-heading">
            {query || Object.keys(filters).some((k) => filters[k as keyof CampFilters] !== undefined)
              ? `Results (${filteredCamps.length})`
              : "All Camps"}
          </h2>
          <Link
            href="/calendar"
            className="btn-secondary text-sm hidden sm:inline-flex"
          >
            Calendar View
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        {filteredCamps.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-cream-200 flex items-center justify-center">
              <Mountain className="w-8 h-8 text-bark-300" />
            </div>
            <h3 className="font-display font-bold text-bark-500 text-lg mb-2">
              No camps found
            </h3>
            <p className="text-bark-300 mb-6">
              Try adjusting your filters or search terms
            </p>
            <button
              onClick={() => {
                setQuery("");
                setFilters({});
              }}
              className="btn-secondary"
            >
              Clear all filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {filteredCamps.map((camp, i) => (
              <div
                key={camp.id}
                className="animate-fade-up"
                style={{ animationDelay: `${i * 0.08}s` }}
              >
                <CampCard camp={camp} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
