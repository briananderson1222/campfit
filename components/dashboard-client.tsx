"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Heart, Bell, Mail, Smartphone, MessageSquare,
  Trash2, ExternalLink, Crown, MapPin, Calendar, CalendarArrowDown, Loader2,
} from "lucide-react";
import {
  CATEGORY_LABELS, CATEGORY_COLORS, STATUS_CONFIG, SavedCamp,
} from "@/lib/types";
import { cn, formatCurrency, getLowestPrice } from "@/lib/utils";

const MAX_FREE_SAVES = 5;

interface DashboardClientProps {
  initialSaves: SavedCamp[];
  userEmail: string;
  isPremium?: boolean;
}

export function DashboardClient({ initialSaves, userEmail, isPremium = false }: DashboardClientProps) {
  const router = useRouter();
  const [savedCamps, setSavedCamps] = useState<SavedCamp[]>(initialSaves);
  const [globalEmail, setGlobalEmail] = useState(true);
  const [globalPush, setGlobalPush] = useState(false);
  const [globalSms, setGlobalSms] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  const handleUpgrade = async () => {
    setUpgrading(true);
    try {
      const res = await fetch("/api/stripe/checkout", { method: "POST" });
      const { url, error } = await res.json();
      if (url) window.location.href = url;
      else console.error("Checkout error:", error);
    } finally {
      setUpgrading(false);
    }
  };

  const removeCamp = async (savedId: string, campId: string) => {
    const res = await fetch(`/api/saves?campId=${campId}`, { method: "DELETE" });
    if (res.ok) {
      setSavedCamps((camps) => camps.filter((c) => c.id !== savedId));
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
      {/* Header */}
      <div className="flex items-start justify-between mb-8 animate-fade-up">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-2xl bg-terracotta-400 flex items-center justify-center">
              <Heart className="w-5 h-5 text-white" />
            </div>
            <h1 className="font-display text-3xl sm:text-4xl font-extrabold text-bark-700 tracking-tight">
              Saved Camps
            </h1>
          </div>
          <p className="text-bark-400 ml-[52px]">
            {isPremium
            ? `${savedCamps.length} saves · Premium`
            : `${savedCamps.length} of ${MAX_FREE_SAVES} saves used (Free plan)`}
            <span className="text-xs text-bark-300 ml-2">· {userEmail}</span>
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {savedCamps.length > 0 && (
            <a
              href="/api/calendar/export"
              download="my-campscout-camps.ics"
              className="btn-secondary text-sm gap-1.5"
              title="Export all saved camps to calendar"
            >
              <CalendarArrowDown className="w-4 h-4" />
              Export .ics
            </a>
          )}
          {!isPremium && (
            <button
              onClick={handleUpgrade}
              disabled={upgrading}
              className="btn-primary text-sm gap-1.5 disabled:opacity-60"
            >
              {upgrading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Crown className="w-4 h-4" />
              )}
              Upgrade
            </button>
          )}
        </div>
      </div>

      {/* Save limit bar */}
      <div className="mb-8 animate-fade-up stagger-1">
        <div className="h-2 rounded-full bg-cream-300/60 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-pine-400 to-pine-500 transition-all duration-500"
            style={{ width: `${Math.min((savedCamps.length / MAX_FREE_SAVES) * 100, 100)}%` }}
          />
        </div>
        {savedCamps.length >= MAX_FREE_SAVES - 1 && (
          <p className="text-xs text-amber-500 mt-2 flex items-center gap-1">
            <Crown className="w-3 h-3" />
            Upgrade to Premium for unlimited saves and all notification channels
          </p>
        )}
      </div>

      {/* Saved camps list */}
      <div className="space-y-4 mb-12">
        {savedCamps.length === 0 ? (
          <div className="text-center py-16 glass-panel">
            <Heart className="w-10 h-10 mx-auto mb-3 text-bark-300 opacity-40" />
            <h3 className="font-display font-bold text-bark-500 text-lg mb-2">
              No saved camps yet
            </h3>
            <p className="text-bark-300 mb-6 text-sm">
              Browse camps and tap the heart to save ones you&apos;re interested in
            </p>
            <Link href="/" className="btn-primary">
              Browse Camps
            </Link>
          </div>
        ) : (
          savedCamps.map((saved, i) => {
            const camp = saved.camp;
            const status = STATUS_CONFIG[camp.registrationStatus];
            const categoryColor = CATEGORY_COLORS[camp.category];
            const lowestPrice = getLowestPrice(camp.pricing);

            return (
              <div
                key={saved.id}
                className="glass-panel p-5 sm:p-6 animate-fade-up"
                style={{ animationDelay: `${i * 0.1 + 0.2}s` }}
              >
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <span className={cn("badge", categoryColor)}>
                        {CATEGORY_LABELS[camp.category]}
                      </span>
                      <span className={cn("badge", status.color)}>
                        {status.label}
                      </span>
                    </div>
                    <Link
                      href={`/camps/${camp.slug}`}
                      className="font-display font-bold text-lg text-bark-700 hover:text-pine-600 transition-colors"
                    >
                      {camp.name}
                    </Link>
                  </div>
                  <button
                    onClick={() => removeCamp(saved.id, saved.campId)}
                    className="p-2 rounded-xl hover:bg-red-50 text-bark-300 hover:text-red-400 transition-colors shrink-0"
                    title="Remove from saved"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-bark-400 mb-4">
                  {camp.neighborhood && (
                    <span className="flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-pine-400" />
                      {camp.neighborhood}
                    </span>
                  )}
                  {lowestPrice !== null && (
                    <span className="font-semibold text-bark-500">
                      {formatCurrency(lowestPrice)}
                      {camp.pricing[0]?.unit === "PER_WEEK" ? "/wk" : ""}
                    </span>
                  )}
                  {camp.registrationOpenDate && (
                    <span className="flex items-center gap-1.5 text-amber-500">
                      <Calendar className="w-3.5 h-3.5" />
                      Reg. opens{" "}
                      {new Date(camp.registrationOpenDate).toLocaleDateString("en-US", {
                        month: "short", day: "numeric",
                      })}
                    </span>
                  )}
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-cream-300/60">
                  <div className="flex items-center gap-1 text-xs text-bark-300">
                    <Bell className="w-3.5 h-3.5" />
                    <span className="font-medium">Notify me via:</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <NotifyToggle icon={<Mail className="w-3.5 h-3.5" />} label="Email" active={saved.notifyEmail} />
                    <NotifyToggle icon={<Smartphone className="w-3.5 h-3.5" />} label="Push" active={saved.notifyPush} premium />
                    <NotifyToggle icon={<MessageSquare className="w-3.5 h-3.5" />} label="SMS" active={saved.notifySms} premium />
                    {camp.websiteUrl && (
                      <a
                        href={camp.websiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 rounded-lg hover:bg-cream-200 text-bark-300 hover:text-pine-500 transition-colors"
                        title="Visit camp website"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Global notification settings */}
      <section className="glass-panel p-6 animate-fade-up stagger-4">
        <h2 className="font-display font-bold text-bark-700 text-lg mb-4 flex items-center gap-2">
          <Bell className="w-5 h-5 text-pine-400" />
          Notification Settings
        </h2>
        <p className="text-sm text-bark-400 mb-5">
          Choose how you want to be notified about your saved camps
        </p>

        <div className="space-y-3">
          <GlobalToggle
            icon={<Mail className="w-4 h-4" />}
            label="Email Notifications"
            description="Get notified when registration opens"
            active={globalEmail}
            onChange={setGlobalEmail}
          />
          <GlobalToggle
            icon={<Smartphone className="w-4 h-4" />}
            label="Push Notifications"
            description="Browser & mobile push alerts"
            active={globalPush}
            onChange={setGlobalPush}
            premium
          />
          <GlobalToggle
            icon={<MessageSquare className="w-4 h-4" />}
            label="SMS Notifications"
            description="Text message reminders"
            active={globalSms}
            onChange={setGlobalSms}
            premium
          />
        </div>
      </section>
    </div>
  );
}

function NotifyToggle({
  icon, label, active, premium = false,
}: {
  icon: React.ReactNode; label: string; active: boolean; premium?: boolean;
}) {
  return (
    <button
      className={cn(
        "flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all",
        active
          ? "bg-pine-100 text-pine-600 border border-pine-200/60"
          : "bg-cream-200/50 text-bark-300 border border-transparent hover:bg-cream-200",
        premium && !active && "opacity-50"
      )}
      title={premium ? `${label} (Premium)` : label}
    >
      {icon}
      {label}
      {premium && <Crown className="w-2.5 h-2.5 text-amber-400" />}
    </button>
  );
}

function GlobalToggle({
  icon, label, description, active, onChange, premium = false,
}: {
  icon: React.ReactNode; label: string; description: string;
  active: boolean; onChange: (v: boolean) => void; premium?: boolean;
}) {
  return (
    <div className={cn(
      "flex items-center justify-between p-4 rounded-2xl transition-colors",
      active ? "bg-pine-50 border border-pine-200/50" : "bg-cream-200/30"
    )}>
      <div className="flex items-center gap-3">
        <div className={cn(
          "w-8 h-8 rounded-lg flex items-center justify-center",
          active ? "bg-pine-500 text-white" : "bg-cream-300/60 text-bark-300"
        )}>
          {icon}
        </div>
        <div>
          <span className="text-sm font-medium text-bark-600 flex items-center gap-1.5">
            {label}
            {premium && (
              <span className="badge bg-amber-100 text-amber-600 text-[10px] py-0">
                <Crown className="w-2.5 h-2.5" />
                Premium
              </span>
            )}
          </span>
          <p className="text-xs text-bark-300">{description}</p>
        </div>
      </div>
      <button
        onClick={() => onChange(!active)}
        className={cn(
          "relative w-11 h-6 rounded-full transition-colors duration-200",
          active ? "bg-pine-500" : "bg-bark-200"
        )}
      >
        <span className={cn(
          "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200",
          active && "translate-x-5"
        )} />
      </button>
    </div>
  );
}
