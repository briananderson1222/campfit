"use client";

import Link from "next/link";
import { Camp, SUMMER_WEEKS, CATEGORY_LABELS, CampCategory } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useCommunity } from "@/lib/community-context";
import { routes } from "@/lib/routes";

interface WeekCalendarProps {
  camps: Camp[];
  compact?: boolean;
}

const CATEGORY_BAR_COLORS: Record<CampCategory, string> = {
  SPORTS: "bg-terracotta-400",
  ARTS: "bg-amber-300",
  STEM: "bg-sky-400",
  NATURE: "bg-pine-500",
  ACADEMIC: "bg-bark-400",
  MUSIC: "bg-purple-500",
  THEATER: "bg-rose-500",
  COOKING: "bg-orange-400",
  MULTI_ACTIVITY: "bg-pine-300",
  OTHER: "bg-clay-300",
};

export function WeekCalendar({ camps, compact = false }: WeekCalendarProps) {
  const { slug: communitySlug } = useCommunity();
  const isAvailable = (camp: Camp, weekStart: string) =>
    camp.schedules.some((s) => s.startDate === weekStart);

  return (
    <div className="overflow-x-auto -mx-4 sm:mx-0">
      <div className="min-w-[720px] px-4 sm:px-0">
        {/* Header row */}
        <div className="flex items-end gap-0 mb-2">
          <div className={cn("shrink-0", compact ? "w-40" : "w-52")} />
          {SUMMER_WEEKS.map((week) => (
            <div
              key={week.start}
              className="flex-1 text-center px-0.5"
            >
              <span className="text-[10px] sm:text-xs font-semibold text-bark-300 uppercase tracking-wide leading-none">
                {week.label.split("-")[0].trim()}
              </span>
            </div>
          ))}
        </div>

        {/* Camp rows */}
        <div className="space-y-1">
          {camps.map((camp) => {
            const barColor = CATEGORY_BAR_COLORS[camp.category];

            return (
              <div key={camp.id} className="flex items-center gap-0 group">
                {/* Camp name */}
                <div className={cn("shrink-0 pr-3", compact ? "w-40" : "w-52")}>
                  <Link
                    href={routes.campDetail(communitySlug, camp.slug)}
                    className="text-sm font-medium text-bark-500 hover:text-pine-600 truncate block transition-colors"
                  >
                    {camp.name}
                  </Link>
                  {!compact && (
                    <span className="text-xs text-bark-300">
                      {CATEGORY_LABELS[camp.category]}
                    </span>
                  )}
                </div>

                {/* Week cells */}
                {SUMMER_WEEKS.map((week) => {
                  const available = isAvailable(camp, week.start);

                  return (
                    <div
                      key={week.start}
                      className="flex-1 px-0.5"
                    >
                      <div
                        className={cn(
                          "h-8 sm:h-10 rounded-lg transition-all duration-200",
                          available
                            ? cn(barColor, "opacity-70 group-hover:opacity-100")
                            : "bg-cream-200/30"
                        )}
                        title={
                          available
                            ? `${camp.name} — ${week.label}`
                            : undefined
                        }
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
