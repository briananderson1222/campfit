"use client";

import { useLang } from "@/lib/i18n/lang-context";
import { cn } from "@/lib/utils";

export function LangToggle({ className }: { className?: string }) {
  const { lang, setLang } = useLang();

  return (
    <div
      className={cn(
        "flex items-center rounded-xl overflow-hidden border",
        "border-cream-400/60 dark:border-bark-600/60",
        "text-xs font-semibold font-body",
        className
      )}
    >
      <button
        onClick={() => setLang("en")}
        aria-label="Switch to English"
        aria-pressed={lang === "en"}
        className={cn(
          "px-2.5 py-1.5 transition-colors",
          lang === "en"
            ? "bg-pine-600 text-cream-100"
            : "text-bark-400 hover:text-bark-600 hover:bg-cream-200/60 dark:text-cream-400 dark:hover:text-cream-200 dark:hover:bg-bark-600/60"
        )}
      >
        EN
      </button>
      <button
        onClick={() => setLang("es")}
        aria-label="Cambiar a español"
        aria-pressed={lang === "es"}
        className={cn(
          "px-2.5 py-1.5 transition-colors",
          lang === "es"
            ? "bg-pine-600 text-cream-100"
            : "text-bark-400 hover:text-bark-600 hover:bg-cream-200/60 dark:text-cream-400 dark:hover:text-cream-200 dark:hover:bg-bark-600/60"
        )}
      >
        ES
      </button>
    </div>
  );
}
