"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Heart, Crown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SaveButtonProps {
  campId: string;
  initialSaved?: boolean;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
}

export function SaveButton({
  campId,
  initialSaved = false,
  size = "md",
  showLabel = false,
}: SaveButtonProps) {
  const router = useRouter();
  const [saved, setSaved] = useState(initialSaved);
  const [animate, setAnimate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [limitReached, setLimitReached] = useState(false);

  const handleClick = async () => {
    if (loading) return;
    setLoading(true);
    setLimitReached(false);

    try {
      if (saved) {
        // Unsave
        const res = await fetch(`/api/saves?campId=${campId}`, {
          method: "DELETE",
        });
        if (res.ok) {
          setSaved(false);
        } else if (res.status === 401) {
          router.push("/auth/login");
        }
      } else {
        // Save
        const res = await fetch("/api/saves", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campId }),
        });
        if (res.ok) {
          setSaved(true);
          setAnimate(true);
          setTimeout(() => setAnimate(false), 600);
        } else if (res.status === 401) {
          router.push("/auth/login");
        } else if (res.status === 403) {
          setLimitReached(true);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const sizeClasses = { sm: "w-8 h-8", md: "w-10 h-10", lg: "w-12 h-12" };
  const iconSizes = { sm: "w-4 h-4", md: "w-5 h-5", lg: "w-6 h-6" };

  if (limitReached) {
    return (
      <button
        onClick={() => router.push("/dashboard")}
        className={cn(
          "rounded-full flex items-center justify-center gap-2 transition-all duration-300",
          "border shadow-sm hover:shadow-md bg-amber-50 border-amber-200 text-amber-500",
          !showLabel && sizeClasses[size],
          showLabel && "px-5 py-2.5"
        )}
        title="Save limit reached — upgrade to Premium"
      >
        <Crown className={iconSizes[size]} />
        {showLabel && (
          <span className="text-sm font-medium font-body">Upgrade</span>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={cn(
        "rounded-full flex items-center justify-center gap-2 transition-all duration-300",
        "border shadow-sm hover:shadow-md active:scale-95",
        saved
          ? "bg-terracotta-50 border-terracotta-200 text-terracotta-400"
          : "bg-cream-50 border-cream-400/50 text-bark-300 hover:text-terracotta-400 hover:border-terracotta-200",
        !showLabel && sizeClasses[size],
        showLabel && "px-5 py-2.5",
        animate && "scale-110",
        loading && "opacity-60 cursor-not-allowed"
      )}
      title={saved ? "Remove from saved" : "Save camp"}
    >
      {loading ? (
        <div
          className={cn(
            "border-2 border-current border-t-transparent rounded-full animate-spin",
            iconSizes[size]
          )}
        />
      ) : (
        <Heart
          className={cn(
            iconSizes[size],
            "transition-all duration-300",
            saved && "fill-terracotta-400 text-terracotta-400",
            animate && "animate-bounce"
          )}
        />
      )}
      {showLabel && (
        <span className="text-sm font-medium font-body">
          {saved ? "Saved" : "Save"}
        </span>
      )}
    </button>
  );
}
