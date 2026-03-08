"use client";

import { useState } from "react";
import { Heart } from "lucide-react";
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
  const [saved, setSaved] = useState(initialSaved);
  const [animate, setAnimate] = useState(false);

  const handleClick = () => {
    setSaved(!saved);
    if (!saved) {
      setAnimate(true);
      setTimeout(() => setAnimate(false), 600);
    }
  };

  const sizeClasses = {
    sm: "w-8 h-8",
    md: "w-10 h-10",
    lg: "w-12 h-12",
  };

  const iconSizes = {
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
  };

  return (
    <button
      onClick={handleClick}
      className={cn(
        "rounded-full flex items-center justify-center gap-2 transition-all duration-300",
        "border shadow-sm hover:shadow-md active:scale-95",
        saved
          ? "bg-terracotta-50 border-terracotta-200 text-terracotta-400"
          : "bg-cream-50 border-cream-400/50 text-bark-300 hover:text-terracotta-400 hover:border-terracotta-200",
        !showLabel && sizeClasses[size],
        showLabel && "px-5 py-2.5",
        animate && "scale-110"
      )}
      title={saved ? "Remove from saved" : "Save camp"}
    >
      <Heart
        className={cn(
          iconSizes[size],
          "transition-all duration-300",
          saved && "fill-terracotta-400 text-terracotta-400",
          animate && "animate-bounce"
        )}
      />
      {showLabel && (
        <span className="text-sm font-medium font-body">
          {saved ? "Saved" : "Save"}
        </span>
      )}
    </button>
  );
}
