"use client";

import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <button className={cn("p-2 rounded-xl transition-colors", className)} aria-label="Toggle theme">
        <span className="w-4 h-4 block" />
      </button>
    );
  }

  function cycleTheme() {
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  }

  const label =
    theme === "light" ? "Switch to dark mode" :
    theme === "dark"  ? "Switch to system theme" :
    "Switch to light mode";

  const Icon =
    theme === "system" ? Monitor :
    resolvedTheme === "dark" ? Moon : Sun;

  return (
    <button
      onClick={cycleTheme}
      className={cn(
        "p-2 rounded-xl transition-colors",
        "text-bark-400 hover:text-bark-600 hover:bg-cream-200/60",
        "dark:text-cream-300 dark:hover:text-cream-100 dark:hover:bg-bark-600/60",
        className
      )}
      aria-label={label}
      title={label}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}
