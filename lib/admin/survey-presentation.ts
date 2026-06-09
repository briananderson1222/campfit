import type { ReviewPresentationAdapter } from '@/lib/kontourai/survey-review-workbench';

export function createCampSurveyPresentationAdapter(fieldLabels: Record<string, string> = {}): ReviewPresentationAdapter {
  return {
    labelForTarget: (target) => fieldLabels[target] ?? humanizeFieldName(target),
    summarizeValue: (value, context) => summarizeCampValue(context.item.spec.target, value),
    linkForReviewItem: (item) => {
      const campId = stringLabel(item.metadata.labels?.campId);
      return campId ? { href: `/admin/camps/${campId}`, label: 'Camp record' } : undefined;
    },
    statusLabel: (status) => statusLabel(status),
  };
}

export function fieldNameForSurveyItem(item: { spec: { target: string }; metadata: { labels?: Record<string, string> } }): string {
  return stringLabel(item.metadata.labels?.field) ?? item.spec.target;
}

export function fieldLabelForSurveyItem(
  item: { spec: { target: string }; metadata: { labels?: Record<string, string> } },
  fieldLabels: Record<string, string> = {},
): string {
  const field = fieldNameForSurveyItem(item);
  return fieldLabels[field] ?? humanizeFieldName(field);
}

export function statusLabel(value: string): string {
  return humanizeFieldName(value);
}

export function sourceAuthorityLabel(value: unknown): string {
  if (!value || typeof value !== 'object') return 'not declared';
  const record = value as Record<string, unknown>;
  return String(record.authorityClass ?? record.declaredBy ?? 'declared');
}

export function formatSurveyDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function humanizeFieldName(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function summarizeCampValue(field: string, value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);

  if (Array.isArray(value)) {
    if (field === 'ageGroups') return `${value.length} age group${value.length === 1 ? '' : 's'}`;
    if (field === 'schedules') return `${value.length} schedule entr${value.length === 1 ? 'y' : 'ies'}`;
    if (field === 'pricing') return `${value.length} pricing option${value.length === 1 ? '' : 's'}`;
    return `${value.length} item${value.length === 1 ? '' : 's'}`;
  }

  if (field === 'socialLinks' && typeof value === 'object') {
    const count = Object.keys(value).length;
    return `${count} social link${count === 1 ? '' : 's'}`;
  }

  return undefined;
}

function stringLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
