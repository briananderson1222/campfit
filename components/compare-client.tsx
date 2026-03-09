"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  X,
  Plus,
  ArrowLeft,
  Check,
  Minus,
  MapPin,
  Clock,
  DollarSign,
  Users,
  CalendarDays,
  ExternalLink,
  Share2,
} from "lucide-react";
import {
  Camp,
  CATEGORY_LABELS,
  CATEGORY_COLORS,
  STATUS_CONFIG,
  CAMP_TYPE_LABELS,
  SUMMER_WEEKS,
} from "@/lib/types";
import { cn, formatCurrency, getAgeRangeSummary } from "@/lib/utils";

const MAX_COMPARE = 3;

interface CompareClientProps {
  initialCamps: Camp[];
}

export function CompareClient({ initialCamps }: CompareClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [camps, setCamps] = useState<Camp[]>(initialCamps);
  const [shareToast, setShareToast] = useState(false);

  const removeCamp = useCallback(
    (slug: string) => {
      const next = camps.filter((c) => c.slug !== slug);
      setCamps(next);
      const params = next.map((c) => c.slug).join(",");
      router.replace(params ? `/compare?camps=${params}` : "/compare", {
        scroll: false,
      });
    },
    [camps, router]
  );

  const handleShare = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      setShareToast(true);
      setTimeout(() => setShareToast(false), 2500);
    });
  };

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-12">
      {/* Header */}
      <div className="flex items-start justify-between mb-8 animate-fade-up">
        <div>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-bark-300 hover:text-pine-500 transition-colors mb-3"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to camps
          </Link>
          <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-bark-700 tracking-tight">
            Compare Camps
          </h1>
          <p className="text-bark-400 mt-1">
            Side-by-side comparison · up to {MAX_COMPARE} camps
          </p>
        </div>
        {camps.length > 1 && (
          <button
            onClick={handleShare}
            className="btn-secondary text-sm gap-1.5 shrink-0 relative"
            title="Copy comparison link"
          >
            <Share2 className="w-4 h-4" />
            Share
            {shareToast && (
              <span className="absolute -top-8 left-1/2 -translate-x-1/2 bg-bark-700 text-white text-xs rounded-lg px-3 py-1.5 whitespace-nowrap shadow-lg">
                Link copied!
              </span>
            )}
          </button>
        )}
      </div>

      {/* Add camp prompt if < MAX */}
      {camps.length < MAX_COMPARE && (
        <div className="mb-6 p-4 rounded-2xl border-2 border-dashed border-pine-200 text-center animate-fade-up stagger-1">
          <Plus className="w-5 h-5 mx-auto mb-1.5 text-pine-400" />
          <p className="text-sm text-bark-400">
            Add camps to compare by clicking{" "}
            <strong className="text-bark-600">Compare</strong> on any camp page.
            {camps.length === 0 && (
              <>
                {" "}
                <Link href="/" className="text-pine-500 underline">
                  Browse camps
                </Link>
              </>
            )}
          </p>
        </div>
      )}

      {camps.length === 0 ? (
        <div className="text-center py-20 glass-panel">
          <CalendarDays className="w-10 h-10 mx-auto mb-3 text-bark-300 opacity-40" />
          <h3 className="font-display font-bold text-bark-500 text-xl mb-2">
            No camps to compare
          </h3>
          <p className="text-bark-300 mb-6">
            Browse camps and click &ldquo;Compare&rdquo; to add them here
          </p>
          <Link href="/" className="btn-primary">
            Browse Camps
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:-mx-6 px-4 sm:px-6">
          <table className="w-full min-w-[600px] border-separate border-spacing-0">
            {/* Camp name headers */}
            <thead>
              <tr>
                <th className="w-36 sm:w-44 text-left pb-4 align-bottom">
                  <span className="text-xs font-semibold text-bark-300 uppercase tracking-wide">
                    Comparing
                  </span>
                </th>
                {camps.map((camp) => (
                  <th key={camp.id} className="pb-4 px-3 align-top">
                    <div className="glass-panel p-4 text-left relative group">
                      <button
                        onClick={() => removeCamp(camp.slug)}
                        className="absolute top-3 right-3 p-1 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-50 text-bark-300 hover:text-red-400 transition-all"
                        title="Remove from comparison"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        <span
                          className={cn(
                            "badge text-[10px]",
                            CATEGORY_COLORS[camp.category]
                          )}
                        >
                          {CATEGORY_LABELS[camp.category]}
                        </span>
                        <span
                          className={cn(
                            "badge text-[10px]",
                            STATUS_CONFIG[camp.registrationStatus].color
                          )}
                        >
                          {STATUS_CONFIG[camp.registrationStatus].label}
                        </span>
                      </div>
                      <Link
                        href={`/camps/${camp.slug}`}
                        className="font-display font-bold text-bark-700 hover:text-pine-600 transition-colors leading-tight block"
                      >
                        {camp.name}
                      </Link>
                      {camp.neighborhood && (
                        <p className="text-xs text-bark-400 mt-1 flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {camp.neighborhood}
                        </p>
                      )}
                    </div>
                  </th>
                ))}
                {/* Empty slot placeholder */}
                {camps.length < MAX_COMPARE && (
                  <th className="pb-4 px-3 align-top">
                    <div className="rounded-2xl border-2 border-dashed border-pine-200/60 p-4 h-full flex flex-col items-center justify-center min-h-[96px]">
                      <Plus className="w-5 h-5 text-pine-300" />
                      <span className="text-xs text-bark-300 mt-1">Add camp</span>
                    </div>
                  </th>
                )}
              </tr>
            </thead>

            <tbody>
              <CompareRow label="Camp Type" icon={<CalendarDays className="w-3.5 h-3.5" />}>
                {camps.map((c) => (
                  <td key={c.id} className="px-3 py-3 align-top">
                    <span className="text-sm text-bark-600">
                      {CAMP_TYPE_LABELS[c.campType] || c.campType}
                    </span>
                  </td>
                ))}
              </CompareRow>

              <CompareRow label="Ages" icon={<Users className="w-3.5 h-3.5" />}>
                {camps.map((c) => (
                  <td key={c.id} className="px-3 py-3 align-top">
                    <span className="text-sm text-bark-600">
                      {getAgeRangeSummary(c.ageGroups)}
                    </span>
                    {c.ageGroups.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {c.ageGroups.map((ag) => (
                          <span
                            key={ag.id}
                            className="text-[10px] px-2 py-0.5 rounded-full bg-pine-50 text-pine-600 border border-pine-200/50"
                          >
                            {ag.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                ))}
              </CompareRow>

              <CompareRow label="Price" icon={<DollarSign className="w-3.5 h-3.5" />}>
                {camps.map((c) => (
                  <td key={c.id} className="px-3 py-3 align-top">
                    {c.pricing.length > 0 ? (
                      <div className="space-y-1">
                        {c.pricing.map((p) => (
                          <div key={p.id} className="flex items-baseline justify-between gap-2">
                            <span className="text-xs text-bark-400">{p.label}</span>
                            <span className="font-display font-bold text-bark-700 text-sm whitespace-nowrap">
                              {formatCurrency(p.amount)}
                              <span className="text-xs font-normal text-bark-300">
                                {p.unit === "PER_WEEK" ? "/wk" : p.unit === "PER_DAY" ? "/day" : ""}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm text-bark-300">Contact camp</span>
                    )}
                  </td>
                ))}
              </CompareRow>

              <CompareRow label="Hours" icon={<Clock className="w-3.5 h-3.5" />}>
                {camps.map((c) => {
                  const s = c.schedules[0];
                  return (
                    <td key={c.id} className="px-3 py-3 align-top">
                      {s?.startTime ? (
                        <div>
                          <span className="text-sm text-bark-600">
                            {s.startTime} – {s.endTime}
                          </span>
                          {(s.earlyDropOff || s.latePickup) && (
                            <p className="text-xs text-bark-400 mt-0.5">
                              {s.earlyDropOff && `Early drop: ${s.earlyDropOff}`}
                              {s.earlyDropOff && s.latePickup && " · "}
                              {s.latePickup && `Late pickup: ${s.latePickup}`}
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-sm text-bark-300">—</span>
                      )}
                    </td>
                  );
                })}
              </CompareRow>

              <CompareRow label="Lunch" icon={<span className="text-xs">🥗</span>}>
                {camps.map((c) => (
                  <td key={c.id} className="px-3 py-3 align-top">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 text-sm",
                        c.lunchIncluded ? "text-pine-600" : "text-bark-400"
                      )}
                    >
                      {c.lunchIncluded ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <Minus className="w-3.5 h-3.5" />
                      )}
                      {c.lunchIncluded ? "Included" : "Not included"}
                    </span>
                  </td>
                ))}
              </CompareRow>

              <CompareRow label="Weeks" icon={<CalendarDays className="w-3.5 h-3.5" />}>
                {camps.map((c) => (
                  <td key={c.id} className="px-3 py-3 align-top">
                    {c.campType === "SUMMER_DAY" ? (
                      <div>
                        <div className="flex flex-wrap gap-1 mb-1">
                          {SUMMER_WEEKS.map((week) => {
                            const available = c.schedules.some(
                              (s) => s.startDate === week.start
                            );
                            return (
                              <div
                                key={week.start}
                                className={cn(
                                  "w-7 h-7 rounded-lg flex items-center justify-center text-[9px] font-medium",
                                  available
                                    ? "bg-pine-500 text-white"
                                    : "bg-cream-200 text-bark-300"
                                )}
                                title={`${week.label}: ${available ? "Available" : "Not available"}`}
                              >
                                {week.label.split(" ")[1]?.split("-")[0]}
                              </div>
                            );
                          })}
                        </div>
                        <p className="text-xs text-bark-400">
                          {c.schedules.length}/{SUMMER_WEEKS.length} weeks
                        </p>
                      </div>
                    ) : (
                      <span className="text-sm text-bark-600">
                        {c.schedules.length} session{c.schedules.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </td>
                ))}
              </CompareRow>

              <CompareRow label="Registration" icon={<CalendarDays className="w-3.5 h-3.5" />}>
                {camps.map((c) => (
                  <td key={c.id} className="px-3 py-3 align-top">
                    {c.registrationOpenDate ? (
                      <span className="text-sm text-amber-600 font-medium">
                        Opens{" "}
                        {new Date(c.registrationOpenDate).toLocaleDateString(
                          "en-US",
                          { month: "short", day: "numeric" }
                        )}
                      </span>
                    ) : (
                      <span className="text-sm text-bark-400">—</span>
                    )}
                  </td>
                ))}
              </CompareRow>

              {/* CTA row */}
              <tr>
                <td className="pt-4 pb-2 pr-3">
                  <span className="text-xs font-semibold text-bark-300 uppercase tracking-wide">
                    Actions
                  </span>
                </td>
                {camps.map((c) => (
                  <td key={c.id} className="px-3 pt-4 pb-2 align-top">
                    <div className="flex flex-col gap-2">
                      <Link
                        href={`/camps/${c.slug}`}
                        className="btn-secondary text-xs py-2 justify-center"
                      >
                        View Details
                      </Link>
                      {c.websiteUrl && (
                        <a
                          href={c.websiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-primary text-xs py-2 justify-center"
                        >
                          Register
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CompareRow({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <tr className="border-t border-cream-300/60">
      <td className="pr-3 py-3 align-top whitespace-nowrap">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-bark-400 uppercase tracking-wide">
          <span className="text-pine-400">{icon}</span>
          {label}
        </div>
      </td>
      {children}
    </tr>
  );
}
