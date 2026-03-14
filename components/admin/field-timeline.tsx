'use client';

import type { FieldTimeline } from '@/lib/admin/field-metadata';

export function FieldTimelineNote({
  timeline,
  className = 'mt-1 text-[11px] text-bark-300',
}: {
  timeline?: FieldTimeline | null;
  className?: string;
}) {
  if (!timeline?.lastUpdatedAt && !timeline?.lastAttestedAt) return null;

  return (
    <p className={className}>
      {timeline.lastUpdatedAt ? <>Updated {shortDateTime(timeline.lastUpdatedAt)}</> : 'Updated —'}
      {' · '}
      {timeline.lastAttestedAt ? <>Attested {shortDateTime(timeline.lastAttestedAt)}</> : 'Attested —'}
    </p>
  );
}

function shortDateTime(value: string) {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
