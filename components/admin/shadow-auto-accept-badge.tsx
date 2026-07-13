import { Sparkles } from 'lucide-react';

/** Advisory-only marker for proposals that pass the current shadow rule. */
export function ShadowAutoAcceptBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      data-shadow-auto-accept="true"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sky-200/70 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:border-sky-300/30 dark:bg-sky-400/10 dark:text-sky-300"
      title="Shadow-mode signal only; this proposal still requires a human decision."
    >
      <Sparkles className="h-3 w-3" />
      would auto-accept
    </span>
  );
}
