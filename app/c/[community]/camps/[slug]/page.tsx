import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  MapPin,
  Clock,
  UtensilsCrossed,
  Sunrise,
  ExternalLink,
  Calendar,
  CalendarPlus,
  DollarSign,
  Users,
  ShieldCheck,
  AlertTriangle,
  Sunset,
} from "lucide-react";
import { getCampBySlug, getCampSlugs } from "@/lib/camp-repository";
import {
  CATEGORY_LABELS,
  CATEGORY_COLORS,
  STATUS_CONFIG,
  CAMP_TYPE_LABELS,
  SUMMER_WEEKS,
} from "@/lib/types";
import { cn, formatCurrency } from "@/lib/utils";
import { SaveButton } from "@/components/save-button";
import { CompareButton } from "@/components/compare-button";
import { LinkifiedText } from "@/components/linkified-text";
import { routes } from "@/lib/routes";

export const revalidate = 3600;

const BASE_URL = "https://camp.fit";

export async function generateMetadata({
  params,
}: {
  params: { community: string; slug: string };
}): Promise<Metadata> {
  const camp = await getCampBySlug(params.slug);
  if (!camp) return {};

  const minPrice = camp.pricing.length
    ? Math.min(...camp.pricing.map((p) => p.amount))
    : null;
  const ageRange =
    camp.ageGroups.length
      ? (() => {
          const ages = camp.ageGroups.flatMap((ag) =>
            ag.minAge !== null && ag.maxAge !== null
              ? [ag.minAge, ag.maxAge]
              : []
          );
          return ages.length
            ? `ages ${Math.min(...ages)}–${Math.max(...ages)}`
            : null;
        })()
      : null;

  const description = [
    camp.description?.slice(0, 120),
    ageRange && `For ${ageRange}.`,
    minPrice && `Starting at ${formatCurrency(minPrice)}.`,
    camp.neighborhood && `Located in ${camp.neighborhood}, ${camp.displayName}.`,
  ]
    .filter(Boolean)
    .join(" ");

  const canonicalUrl = `${BASE_URL}/c/${params.community}/camps/${camp.slug}`;

  return {
    title: `${camp.name} — ${camp.displayName} Kids Camp | CampFit`,
    description,
    openGraph: {
      title: `${camp.name} | CampFit`,
      description,
      url: canonicalUrl,
      siteName: "CampFit",
      type: "website",
    },
    twitter: {
      card: "summary",
      title: `${camp.name} | CampFit`,
      description,
    },
    alternates: {
      canonical: canonicalUrl,
    },
  };
}

export async function generateStaticParams() {
  const slugs = await getCampSlugs();
  return slugs.map((c) => ({ community: c.communitySlug, slug: c.slug }));
}

export default async function CommunityDetailPage({
  params,
}: {
  params: { community: string; slug: string };
}) {
  const camp = await getCampBySlug(params.slug);

  if (!camp) notFound();

  const status = STATUS_CONFIG[camp.registrationStatus];
  const categoryColor = CATEGORY_COLORS[camp.category];
  const firstSchedule = camp.schedules[0];

  const weekAvailability = SUMMER_WEEKS.map((week) => ({
    ...week,
    available: camp.schedules.some((s) => s.startDate === week.start),
  }));

  const canonicalUrl = `${BASE_URL}/c/${params.community}/camps/${camp.slug}`;

  // JSON-LD structured data
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: camp.name,
    description: camp.description,
    url: canonicalUrl,
    ...(camp.address && {
      location: {
        "@type": "Place",
        name: camp.name,
        address: {
          "@type": "PostalAddress",
          streetAddress: camp.address,
          addressLocality: camp.displayName,
          addressRegion: "CO",
          addressCountry: "US",
        },
      },
    }),
    ...(firstSchedule && {
      startDate: firstSchedule.startDate,
      endDate: firstSchedule.endDate,
    }),
    ...(camp.pricing.length > 0 && {
      offers: camp.pricing.map((p) => ({
        "@type": "Offer",
        name: p.label,
        price: p.amount,
        priceCurrency: "USD",
        availability:
          camp.registrationStatus === "OPEN"
            ? "https://schema.org/InStock"
            : "https://schema.org/SoldOut",
        ...(camp.websiteUrl && { url: camp.websiteUrl }),
      })),
    }),
    organizer: {
      "@type": "Organization",
      name: camp.name,
    },
    audience: {
      "@type": "Audience",
      audienceType: "Children",
    },
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
  };

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-8 sm:py-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* Breadcrumb */}
      <Link
        href={routes.community(params.community)}
        className="inline-flex items-center gap-1.5 text-sm text-bark-300 hover:text-pine-500 transition-colors mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to camps
      </Link>

      {/* Header */}
      <div className="mb-8 animate-fade-up">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className={cn("badge", categoryColor)}>
            {CATEGORY_LABELS[camp.category]}
          </span>
          {camp.campType !== "SUMMER_DAY" && (
            <span className="badge bg-clay-100 text-clay-500">
              {CAMP_TYPE_LABELS[camp.campType]}
            </span>
          )}
          <span className={cn("badge", status.color)}>{status.label}</span>
          {camp.dataConfidence === "PLACEHOLDER" && (
            <span className="badge bg-amber-50 text-amber-600 gap-1">
              <AlertTriangle className="w-3 h-3" />
              Unverified
            </span>
          )}
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-bark-700 tracking-tight">
              {camp.name}
            </h1>
            {camp.websiteUrl && (
              <a
                href={camp.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-pine-500 hover:text-pine-600 mt-1 break-all"
              >
                <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                {camp.websiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
              </a>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <CompareButton slug={camp.slug} />
            <SaveButton campId={camp.id} size="lg" showLabel />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-4 text-bark-400">
          {camp.address && (
            <span className="flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-pine-400" />
              {camp.address}
            </span>
          )}
          {camp.neighborhood && !camp.address && (
            <span className="flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-pine-400" />
              {camp.neighborhood}, {camp.displayName}
            </span>
          )}
          {firstSchedule?.startTime && (
            <span className="flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-pine-400" />
              {firstSchedule.startTime} – {firstSchedule.endTime}
            </span>
          )}
        </div>
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column — main content */}
        <div className="lg:col-span-2 space-y-6">
          {/* About */}
          <section className="glass-panel p-6 animate-fade-up stagger-1">
            <h2 className="font-display font-bold text-bark-700 text-lg mb-3">
              About
            </h2>
            <p className="text-bark-500 leading-relaxed">
              <LinkifiedText text={camp.description} />
            </p>
            {camp.notes && (
              <p className="text-sm text-bark-400 mt-3 leading-relaxed">
                <LinkifiedText text={camp.notes} />
              </p>
            )}
            {camp.interestingDetails && (
              <div className="mt-4 px-4 py-3 rounded-2xl bg-amber-300/10 border border-amber-300/30">
                <p className="text-sm text-amber-600 font-medium">
                  <LinkifiedText text={camp.interestingDetails} />
                </p>
              </div>
            )}
          </section>

          {/* Weekly Availability (summer camps only) */}
          {camp.campType === "SUMMER_DAY" && (
            <section className="glass-panel p-6 animate-fade-up stagger-2">
              <h2 className="font-display font-bold text-bark-700 text-lg mb-4 flex items-center gap-2">
                <Calendar className="w-5 h-5 text-pine-400" />
                Weekly Availability
              </h2>
              {camp.schedules.length === 0 ? (
                <p className="text-sm text-bark-400">
                  Weekly schedule not yet available — check the camp website for dates.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {weekAvailability.map((week) => (
                      <div
                        key={week.start}
                        className={cn(
                          "week-cell",
                          week.available
                            ? "week-cell-available"
                            : "week-cell-unavailable"
                        )}
                        title={
                          week.available
                            ? `Available: ${week.label}`
                            : `Not available: ${week.label}`
                        }
                      >
                        <span className="text-[10px] leading-tight text-center">
                          {week.label.split(" ")[0]}
                          <br />
                          {week.label.split(" ")[1]?.replace("-", "\u2013") || ""}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-bark-300 mt-3">
                    {camp.schedules.length} of {SUMMER_WEEKS.length} weeks available
                  </p>
                </>
              )}
            </section>
          )}

          {/* Non-summer schedules */}
          {camp.campType !== "SUMMER_DAY" && camp.schedules.length > 0 && (
            <section className="glass-panel p-6 animate-fade-up stagger-2">
              <h2 className="font-display font-bold text-bark-700 text-lg mb-4 flex items-center gap-2">
                <Calendar className="w-5 h-5 text-pine-400" />
                Schedule
              </h2>
              <div className="space-y-2">
                {[...camp.schedules].sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? "")).map((s) => {
                  const hasDate = s.startDate && s.startDate !== "1970-01-01";
                  const dateRange = hasDate
                    ? (() => {
                        const fmt = (d: string) =>
                          new Date(d + "T12:00:00").toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          });
                        return s.endDate && s.endDate !== s.startDate
                          ? `${fmt(s.startDate)} – ${fmt(s.endDate)}`
                          : fmt(s.startDate);
                      })()
                    : null;

                  return (
                  <div
                    key={s.id}
                    className="flex items-start justify-between gap-3 px-4 py-3 rounded-xl bg-pine-50 border border-pine-200/40"
                  >
                    <div>
                      <span className="text-sm font-medium text-bark-600">
                        {s.label}
                      </span>
                      {dateRange ? (
                        <p className="text-xs text-pine-500 mt-0.5">{dateRange}</p>
                      ) : (
                        <p className="text-xs text-bark-300 mt-0.5 italic">Dates TBD — check camp website</p>
                      )}
                    </div>
                    {s.startTime && (
                      <span className="text-xs text-bark-400 shrink-0 mt-0.5">
                        {s.startTime} – {s.endTime}
                      </span>
                    )}
                  </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Ages & Grades */}
          {camp.ageGroups.length > 0 && (
            <section className="glass-panel p-6 animate-fade-up stagger-3">
              <h2 className="font-display font-bold text-bark-700 text-lg mb-4 flex items-center gap-2">
                <Users className="w-5 h-5 text-pine-400" />
                Ages & Grades
              </h2>
              <div className="flex flex-wrap gap-3">
                {camp.ageGroups.map((ag) => (
                  <div
                    key={ag.id}
                    className="px-4 py-3 rounded-2xl bg-pine-50 border border-pine-200/50"
                  >
                    <span className="font-display font-semibold text-pine-600 text-sm">
                      {ag.label}
                    </span>
                    {ag.minAge !== null && ag.maxAge !== null && (
                      <p className="text-xs text-pine-400 mt-0.5">
                        Ages {ag.minAge}–{ag.maxAge}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Right column — sidebar */}
        <div className="space-y-6">
          {/* Pricing */}
          {camp.pricing.length > 0 && (
            <section className="glass-panel p-6 animate-fade-up stagger-1">
              <h2 className="font-display font-bold text-bark-700 text-lg mb-4 flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-pine-400" />
                Pricing
              </h2>
              <div className="space-y-3">
                {camp.pricing.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-start justify-between p-3 rounded-xl bg-cream-200/40"
                  >
                    <div>
                      <span className="text-sm font-medium text-bark-500">
                        {p.label}
                      </span>
                      {p.ageQualifier && (
                        <p className="text-xs text-bark-300">{p.ageQualifier}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <span className="font-display font-bold text-bark-700">
                        {formatCurrency(p.amount)}
                      </span>
                      <span className="text-xs text-bark-300 block">
                        {p.unit === "FLAT"
                          ? "total"
                          : p.unit === "PER_CAMP"
                            ? "/session"
                            : p.unit === "PER_DAY"
                              ? "/day"
                              : "/week"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              {camp.pricing.some((p) => p.discountNotes) && (
                <div className="mt-3 text-xs text-pine-500 space-y-1">
                  {camp.pricing
                    .filter((p) => p.discountNotes)
                    .map((p) => (
                      <p key={p.id}>{p.discountNotes}</p>
                    ))}
                </div>
              )}
            </section>
          )}

          {/* Details */}
          <section className="glass-panel p-6 animate-fade-up stagger-2">
            <h2 className="font-display font-bold text-bark-700 text-lg mb-4">
              Details
            </h2>
            <div className="space-y-3">
              {camp.neighborhood && (
                <DetailRow
                  icon={<MapPin className="w-4 h-4 text-pine-400" />}
                  label="Neighborhood"
                  value={camp.neighborhood}
                />
              )}
              {firstSchedule?.startTime && (
                <DetailRow
                  icon={<Clock className="w-4 h-4 text-pine-400" />}
                  label="Hours"
                  value={`${firstSchedule.startTime} – ${firstSchedule.endTime}`}
                />
              )}
              <DetailRow
                icon={<UtensilsCrossed className="w-4 h-4 text-pine-400" />}
                label="Lunch"
                value={camp.lunchIncluded ? "Included" : "Not included"}
              />
              {firstSchedule?.earlyDropOff && (
                <DetailRow
                  icon={<Sunrise className="w-4 h-4 text-amber-400" />}
                  label="Early Drop-off"
                  value={firstSchedule.earlyDropOff}
                />
              )}
              {firstSchedule?.latePickup && (
                <DetailRow
                  icon={<Sunset className="w-4 h-4 text-terracotta-400" />}
                  label="Late Pickup"
                  value={`Until ${firstSchedule.latePickup}`}
                />
              )}
              {camp.registrationOpenDate && (
                <DetailRow
                  icon={<Calendar className="w-4 h-4 text-pine-400" />}
                  label="Registration Opens"
                  value={new Date(camp.registrationOpenDate).toLocaleDateString(
                    "en-US",
                    { month: "long", day: "numeric", year: "numeric" }
                  )}
                />
              )}
              <DetailRow
                icon={<ShieldCheck className="w-4 h-4 text-pine-400" />}
                label="Data Status"
                value={
                  camp.dataConfidence === "VERIFIED"
                    ? "Verified 2026"
                    : "Unverified — check camp website"
                }
              />
            </div>
          </section>

          {/* CTA */}
          {camp.websiteUrl && (
            <a
              href={camp.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary w-full text-base py-4"
            >
              Register at Camp Website
              <ExternalLink className="w-4 h-4" />
            </a>
          )}

          {/* Calendar export */}
          {camp.schedules.length > 0 && (
            <a
              href={routes.campCalendarApi(camp.slug)}
              download
              className="btn-secondary w-full text-sm py-3 flex items-center justify-center gap-2"
            >
              <CalendarPlus className="w-4 h-4" />
              Add to Calendar (.ics)
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div>
        <span className="text-xs text-bark-300 uppercase tracking-wide font-semibold">
          {label}
        </span>
        <p className="text-sm text-bark-500">{value}</p>
      </div>
    </div>
  );
}
