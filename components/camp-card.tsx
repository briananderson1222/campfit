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

export function CampCard({ camp }: { camp: Camp }) {
  const lowestPrice = getLowestPrice(camp.pricing);
  const ageRange = getAgeRangeSummary(camp.ageGroups);
  const status = STATUS_CONFIG[camp.registrationStatus];
  const categoryColor = CATEGORY_COLORS[camp.category];
  const weeksAvailable = camp.schedules.length;
  const firstSchedule = camp.schedules[0];

  return (
    <Link href={`/camps/${camp.slug}`} className="camp-card group block">
      {/* Header stripe */}
      <div className="h-2 bg-gradient-to-r from-pine-500 via-pine-400 to-pine-300 opacity-80 group-hover:opacity-100 transition-opacity" />

      <div className="p-5 sm:p-6">
        {/* Top row: category + status */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("badge", categoryColor)}>
              {CATEGORY_LABELS[camp.category]}
            </span>
            {camp.campType !== "SUMMER_DAY" && (
              <span className="badge bg-clay-100 text-clay-500">
                {CAMP_TYPE_LABELS[camp.campType]}
              </span>
            )}
          </div>
          <span className={cn("badge whitespace-nowrap", status.color)}>
            {status.label}
          </span>
        </div>

        {/* Name */}
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

        {/* Bottom row: age, price, weeks */}
        <div className="flex items-end justify-between pt-3 border-t border-cream-300/60">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-bark-300 uppercase tracking-wide font-semibold">
              {ageRange}
            </span>
            <span className="text-xs text-bark-300">
              {weeksAvailable} week{weeksAvailable !== 1 ? "s" : ""} available
            </span>
          </div>

          <div className="text-right">
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

      {/* Action buttons overlay */}
      <div className="absolute top-5 right-4 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-all duration-200">
        <CompareButton slug={camp.slug} className="shadow-sm bg-cream-50/90 backdrop-blur-sm" />
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className="w-9 h-9 rounded-full bg-cream-50/90 backdrop-blur-sm
            flex items-center justify-center shadow-sm hover:bg-terracotta-50
            transition-colors border border-cream-400/40"
          title="Save camp"
        >
          <Heart className="w-4 h-4 text-bark-400 hover:text-terracotta-400 transition-colors" />
        </button>
      </div>
    </Link>
  );
}
