"use client";

import Link from "next/link";
import {
  MapPin,
  Clock,
  UtensilsCrossed,
  Heart,
  Sunrise,
} from "lucide-react";
import {
  Camp,
  CATEGORY_LABELS,
  CATEGORY_COLORS,
  STATUS_CONFIG,
  CAMP_TYPE_LABELS,
} from "@/lib/types";
import { cn, formatCurrency, getLowestPrice, getAgeRangeSummary } from "@/lib/utils";
import { CompareButton } from "@/components/compare-button";
import { useCommunity } from "@/lib/community-context";
import { useSaves } from "@/lib/saves-context";
import { routes } from "@/lib/routes";

export function CampCard({ camp }: { camp: Camp }) {
  const { slug: communitySlug } = useCommunity();
  const { isSaved, toggle } = useSaves();
  const saved = isSaved(camp.id);
  const lowestPrice = getLowestPrice(camp.pricing);
  const ageRange = getAgeRangeSummary(camp.ageGroups);
  const status = STATUS_CONFIG[camp.registrationStatus];
  const categoryColor = CATEGORY_COLORS[camp.category];
  const weeksAvailable = camp.schedules.length;
  const firstSchedule = camp.schedules[0];

  return (
    <div className="camp-card group">
      {/* Header stripe */}
      <div className="h-2 bg-gradient-to-r from-pine-500 via-pine-400 to-pine-300 opacity-80 group-hover:opacity-100 transition-opacity" />

      <div className="p-5 sm:p-6">
        {/* Top row: badges + save button */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span className={cn("badge", categoryColor)}>
              {CATEGORY_LABELS[camp.category]}
            </span>
            {camp.campType !== "SUMMER_DAY" && (
              <span className="badge bg-clay-100 text-clay-500">
                {CAMP_TYPE_LABELS[camp.campType]}
              </span>
            )}
            <span className={cn("badge whitespace-nowrap", status.color)}>
              {status.label}
            </span>
          </div>

          {/* Save button — always visible, stops link navigation */}
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggle(camp.id);
            }}
            className={cn(
              "shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors border",
              saved
                ? "bg-terracotta-50 border-terracotta-300"
                : "bg-cream-200/60 hover:bg-terracotta-50 border-cream-400/40"
            )}
            title={saved ? "Remove from saved" : "Save camp"}
          >
            <Heart className={cn(
              "w-3.5 h-3.5 transition-colors",
              saved ? "text-terracotta-400 fill-terracotta-400" : "text-bark-400 hover:text-terracotta-400"
            )} />
          </button>
        </div>

        {/* Name — full-width link */}
        <Link href={routes.campDetail(communitySlug, camp.slug)} className="block">
          <h3 className="font-display font-bold text-lg text-bark-700 leading-snug mb-2 group-hover:text-pine-600 transition-colors">
            {camp.name}
          </h3>

          {/* Description snippet */}
          <p className="text-sm text-bark-400 leading-relaxed line-clamp-2 mb-4">
            {camp.description}
          </p>

          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-bark-400 mb-4">
            <span className="flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-pine-400" />
              {camp.neighborhood}
            </span>
            {firstSchedule?.startTime && (
              <span className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-pine-400" />
                {firstSchedule.startTime} - {firstSchedule.endTime}
              </span>
            )}
            {camp.lunchIncluded && (
              <span className="flex items-center gap-1.5 text-pine-500">
                <UtensilsCrossed className="w-3.5 h-3.5" />
                Lunch
              </span>
            )}
            {firstSchedule?.earlyDropOff && (
              <span className="flex items-center gap-1.5 text-amber-500">
                <Sunrise className="w-3.5 h-3.5" />
                Early drop-off
              </span>
            )}
          </div>
        </Link>

        {/* Bottom row: age/weeks + compare + price */}
        <div className="flex items-end justify-between gap-3 pt-3 border-t border-cream-300/60">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="text-xs text-bark-300 uppercase tracking-wide font-semibold">
              {ageRange}
            </span>
            {camp.campType === "SUMMER_DAY" && (
              <span className="text-xs text-bark-300">
                {weeksAvailable > 0
                  ? `${weeksAvailable} week${weeksAvailable !== 1 ? "s" : ""} available`
                  : "Contact for schedule"}
              </span>
            )}
            {/* Compare button — always visible on mobile */}
            <CompareButton slug={camp.slug} className="self-start mt-0.5" />
          </div>

          <div className="text-right shrink-0">
            {lowestPrice !== null ? (
              <>
                <span className="font-display font-bold text-xl text-bark-700">
                  {formatCurrency(lowestPrice)}
                </span>
                <span className="text-xs text-bark-300 block">
                  {camp.pricing[0]?.unit === "FLAT"
                    ? "total"
                    : camp.pricing[0]?.unit === "PER_CAMP"
                      ? "/session"
                      : "/week"}
                </span>
              </>
            ) : (
              <span className="text-sm text-bark-300 italic">Contact for pricing</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
