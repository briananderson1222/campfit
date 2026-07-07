import { CheckCircle2, XCircle, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FieldFormatState } from '@/lib/admin/review-format-validation';

/**
 * FieldFormatBadge — renders `checkFieldFormat`'s result as a small inline
 * badge next to a diff row's existing confidence/mode badges
 * (review-panel.tsx:~529-545). Mirrors those badges' Tailwind classes
 * (rounded-full pill, text-xs, px-1.5 py-0.5) for visual consistency: pine/
 * green for valid, red for invalid, neutral/gray for uncheckable.
 */
export function FieldFormatBadge({ state }: { state: FieldFormatState }) {
  const config = FORMAT_BADGE_CONFIG[state];
  const Icon = config.icon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full font-medium',
        config.className,
      )}
      title={config.title}
      data-testid="field-format-badge"
      data-format-state={state}
    >
      <Icon className="w-3 h-3" />
      {config.label}
    </span>
  );
}

const FORMAT_BADGE_CONFIG: Record<
  FieldFormatState,
  { label: string; title: string; icon: typeof CheckCircle2; className: string }
> = {
  valid: {
    label: 'Valid format',
    title: 'This value conforms to the pipeline’s schema for this field.',
    icon: CheckCircle2,
    className: 'bg-pine-100 text-pine-600 admin-chip',
  },
  invalid: {
    label: 'Invalid format',
    title: 'This value does not conform to the pipeline’s schema for this field.',
    icon: XCircle,
    className: 'bg-red-100 text-red-500 dark:border dark:border-red-300/30',
  },
  uncheckable: {
    label: 'Format not checkable',
    title: 'This field has no schema entry to check the format against.',
    icon: HelpCircle,
    className: 'bg-cream-200 text-bark-400 dark:border dark:border-bark-500/30',
  },
};
