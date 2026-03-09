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
        <h1 className="font-display text-5xl sm:text-6xl font-extrabold text-bark-700 tracking-tight mb-4">
          Find camps in<br />
          <span className="text-pine-500">your city</span>
        </h1>
        <p className="text-bark-400 text-lg max-w-md mx-auto">
          Browse kids&apos; camps by age, activity, and availability — all in one place.
        </p>
      </div>

      {/* Search input */}
      <div className="w-full max-w-md mb-8 animate-fade-up stagger-1">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-bark-300" />
          <input
            type="text"
            placeholder="Search your city..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-12 pr-4 py-4 rounded-2xl border border-cream-400/60 bg-white/80 backdrop-blur-sm text-bark-600 placeholder-bark-300 focus:outline-none focus:ring-2 focus:ring-pine-400/40 text-lg shadow-sm"
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
            className="flex items-center justify-between w-full px-6 py-5 rounded-2xl bg-white/80 backdrop-blur-sm border border-cream-400/40 hover:border-pine-300 hover:bg-pine-50/50 transition-all group shadow-sm"
          >
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-pine-100 flex items-center justify-center">
                <MapPin className="w-5 h-5 text-pine-500" />
              </div>
              <div className="text-left">
                <span className="font-display font-bold text-bark-700 text-lg group-hover:text-pine-600 transition-colors">
                  {community.displayName}
                </span>
                <p className="text-sm text-bark-400">{community.count} camps available</p>
              </div>
            </div>
            <ArrowRight className="w-5 h-5 text-bark-300 group-hover:text-pine-500 group-hover:translate-x-1 transition-all" />
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="text-center text-bark-400 py-8">No cities found matching &ldquo;{query}&rdquo;</p>
        )}
      </div>
    </div>
  );
}
