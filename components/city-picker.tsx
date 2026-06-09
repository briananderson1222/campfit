"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { MapPin, Search, ArrowRight } from "lucide-react";
import { Community } from "@/lib/types";
import { routes } from "@/lib/routes";

export function CityPicker({ communities }: { communities: Community[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const filtered = communities.filter((c) =>
    c.displayName.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-4 py-16">
      {/* Hero */}
      <div className="text-center mb-12 animate-fade-up">
        <h1 className="font-display text-5xl sm:text-6xl font-extrabold city-picker-title tracking-tight mb-4">
          Find camps in<br />
          <span className="city-picker-title-accent">your city</span>
        </h1>
        <p className="city-picker-copy text-lg max-w-md mx-auto">
          Browse kids&apos; camps by age, activity, and availability — all in one place.
        </p>
      </div>

      {/* Search input */}
      <div className="w-full max-w-md mb-8 animate-fade-up stagger-1">
        <div className="relative">
          <Search className="city-picker-input-icon absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5" />
          <input
            type="text"
            placeholder="Search your city..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="city-picker-input w-full pl-12 pr-4 py-4 text-lg"
            autoFocus
          />
        </div>
      </div>

      {/* Community cards */}
      <div className="w-full max-w-2xl grid gap-3 animate-fade-up stagger-2">
        {filtered.map((community) => (
          <button
            key={community.communitySlug}
            onClick={() => router.push(routes.community(community.communitySlug))}
            className="city-picker-card flex items-center justify-between w-full px-6 py-5 group"
          >
            <div className="flex items-center gap-4 min-w-0">
              <div className="city-picker-card-icon w-10 h-10 rounded-xl flex shrink-0 items-center justify-center">
                <MapPin className="w-5 h-5" />
              </div>
              <div className="text-left min-w-0">
                <span className="city-picker-card-title block truncate font-display font-bold text-lg transition-colors">
                  {community.displayName}
                </span>
                <p className="city-picker-card-meta text-sm">{community.count} camps available</p>
              </div>
            </div>
            <ArrowRight className="city-picker-card-arrow w-5 h-5 shrink-0 group-hover:translate-x-1 transition-all" />
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="city-picker-copy text-center py-8">No cities found matching &ldquo;{query}&rdquo;</p>
        )}
      </div>
    </div>
  );
}
