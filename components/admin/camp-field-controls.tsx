'use client';

import type { ReactNode } from 'react';
import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ENUM_OPTIONS, labelFor } from '@/lib/enums';
import { CAMP_TYPE_DESCRIPTIONS } from '@/lib/types';

type ArrayRow = Record<string, unknown>;
type SocialLinksValue = Record<string, string>;

export function cloneEditableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((row) => ({ ...(row as Record<string, unknown>) }));
  if (value && typeof value === 'object') return { ...(value as Record<string, unknown>) };
  return value ?? '';
}

export function normalizeEditableValue(
  field: string,
  value: unknown,
  type?: 'text' | 'textarea' | 'select' | 'boolean' | 'date',
): unknown {
  if (field === 'socialLinks') {
    if (!value) return {};
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }
    return cloneEditableValue(value);
  }

  if (type === 'boolean') {
    if (value === true || value === 'true') return 'true';
    if (value === false || value === 'false') return 'false';
    return '';
  }

  return value == null ? '' : String(value);
}

export function parseEditableValue(
  field: string,
  value: unknown,
  type?: 'text' | 'textarea' | 'select' | 'boolean' | 'date',
): unknown {
  if (field === 'socialLinks') {
    const rows = Object.entries((value as Record<string, unknown>) ?? {})
      .map(([platform, url]) => [platform.trim(), String(url ?? '').trim()] as const)
      .filter(([platform, url]) => platform && url);
    return rows.length ? Object.fromEntries(rows) : null;
  }

  if (type === 'boolean') {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return null;
  }

  if (typeof value === 'string') return value.trim() === '' ? null : value;
  return value ?? null;
}

export function CampFieldValue({
  value,
  field,
  expanded,
  highlight,
}: {
  value: unknown;
  field: string;
  expanded?: boolean;
  highlight?: boolean;
}) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-bark-200 italic">empty</span>;
  }

  if (typeof value === 'boolean') {
    return <span className={highlight ? 'text-pine-600 font-medium' : 'text-bark-500'}>{value ? 'Yes' : 'No'}</span>;
  }

  if (Array.isArray(value)) {
    if (field === 'ageGroups') return <AgeGroupsValue rows={value as ArrayRow[]} highlight={highlight} />;
    if (field === 'schedules') return <SchedulesValue rows={value as ArrayRow[]} highlight={highlight} />;
    if (field === 'pricing') return <PricingValue rows={value as ArrayRow[]} highlight={highlight} />;

    return (
      <pre className={cn(
        'text-xs rounded-lg p-2 overflow-hidden whitespace-pre-wrap break-all font-mono',
        highlight ? 'bg-pine-50 text-pine-700 border border-pine-200/50' : 'bg-cream-200/60 text-bark-500',
        !expanded && 'max-h-24',
      )}>
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }

  if (field === 'socialLinks' && typeof value === 'object') {
    return <SocialLinksValueView value={value as SocialLinksValue} highlight={highlight} />;
  }

  const str = String(value);
  if (ENUM_OPTIONS[field]) {
    return (
      <p className={cn('leading-relaxed', highlight ? 'text-pine-700 font-medium' : 'text-bark-500')}>
        {labelFor(field, str)}
      </p>
    );
  }

  if (str.match(/^\d{4}-\d{2}-\d{2}/)) {
    return (
      <p className={cn('leading-relaxed', highlight ? 'text-pine-700 font-medium' : 'text-bark-500')}>
        {new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
      </p>
    );
  }

  const text = !expanded && str.length > 120 ? `${str.slice(0, 120)}…` : str;
  const isUrl = field === 'websiteUrl' || field === 'applicationUrl';
  return (
    <div className={cn('leading-relaxed', highlight ? 'text-pine-700' : 'text-bark-500')}>
      <span>{text}</span>
      {isUrl && (
        <a
          href={str}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-1.5 inline-flex items-center gap-0.5 text-pine-500 hover:text-pine-700"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

export function CampFieldInput({
  field,
  value,
  onChange,
  onCommit,
  onCancel,
  className,
}: {
  field: string;
  value: unknown;
  onChange: (value: unknown) => void;
  onCommit: () => void;
  onCancel: () => void;
  className?: string;
}) {
  const enumOpts = ENUM_OPTIONS[field];

  if (field === 'socialLinks') {
    return (
      <SocialLinksEditor
        value={(value as SocialLinksValue) ?? {}}
        onChange={onChange}
        className={className}
      />
    );
  }

  if (enumOpts) {
    return (
      <select
        autoFocus
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}
        onBlur={onCommit}
        className={cn('flex-1 text-sm border rounded px-2 py-1.5 focus:outline-none bg-white', className)}
      >
        <option value="">— unset —</option>
        {enumOpts.map((option) => (
          <option
            key={option.value}
            value={option.value}
            title={field === 'campType' ? CAMP_TYPE_DESCRIPTIONS[option.value as keyof typeof CAMP_TYPE_DESCRIPTIONS] : undefined}
          >
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (field === 'lunchIncluded') {
    return (
      <select
        autoFocus
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}
        onBlur={onCommit}
        className={cn('flex-1 text-sm border rounded px-2 py-1.5 focus:outline-none bg-white', className)}
      >
        <option value="">— unset —</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }

  const stringValue = String(value ?? '');
  const isDate = field.toLowerCase().includes('date');
  const isLong = stringValue.length > 80 || ['description', 'interestingDetails', 'notes'].includes(field);
  if (isLong) {
    return (
      <textarea
        autoFocus
        value={stringValue}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onCommit();
          }
          if (event.key === 'Escape') onCancel();
        }}
        rows={3}
        className={cn('flex-1 text-sm border rounded px-2 py-1.5 focus:outline-none bg-white resize-none', className)}
      />
    );
  }

  return (
    <input
      autoFocus
      type={isDate ? 'date' : 'text'}
      value={stringValue}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit();
        if (event.key === 'Escape') onCancel();
      }}
      className={cn('flex-1 text-sm border rounded px-2 py-1.5 focus:outline-none bg-white', className)}
    />
  );
}

export function CampArrayFieldEditor({
  field,
  rows,
  onChange,
  onAdd,
  onRemove,
}: {
  field: string;
  rows: ArrayRow[];
  onChange: (field: string, index: number, key: string, value: string) => void;
  onAdd: (field: string) => void;
  onRemove: (field: string, index: number) => void;
}) {
  const columns = field === 'ageGroups'
    ? [
        { key: 'label', label: 'Label', type: 'text' },
        { key: 'minAge', label: 'Min Age', type: 'number' },
        { key: 'maxAge', label: 'Max Age', type: 'number' },
        { key: 'minGrade', label: 'Min Grade', type: 'text' },
        { key: 'maxGrade', label: 'Max Grade', type: 'text' },
      ]
    : field === 'schedules'
      ? [
          { key: 'label', label: 'Label', type: 'text' },
          { key: 'startDate', label: 'Start', type: 'date' },
          { key: 'endDate', label: 'End', type: 'date' },
          { key: 'startTime', label: 'Start Time', type: 'text' },
          { key: 'endTime', label: 'End Time', type: 'text' },
          { key: 'earlyDropOff', label: 'Early Dropoff', type: 'text' },
          { key: 'latePickup', label: 'Late Pickup', type: 'text' },
        ]
      : [
          { key: 'label', label: 'Label', type: 'text' },
          { key: 'amount', label: 'Amount', type: 'number' },
          { key: 'unit', label: 'Unit', type: 'select' },
          { key: 'durationWeeks', label: 'Weeks', type: 'number' },
          { key: 'ageQualifier', label: 'Age Qualifier', type: 'text' },
          { key: 'discountNotes', label: 'Discount Notes', type: 'text' },
        ];

  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={`${field}-${index}`} className="rounded-lg border border-cream-300 bg-white p-2">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {columns.map((column) => (
              column.type === 'select' ? (
                <label key={column.key} className="space-y-1">
                  <span className="text-[11px] uppercase tracking-wide text-bark-300">{column.label}</span>
                  <select
                    value={String(row[column.key] ?? 'PER_WEEK')}
                    onChange={(event) => onChange(field, index, column.key, event.target.value)}
                    className="w-full rounded border border-cream-300 px-2 py-1 text-xs"
                  >
                    <option value="PER_WEEK">Per Week</option>
                    <option value="PER_SESSION">Per Session</option>
                    <option value="PER_DAY">Per Day</option>
                    <option value="FLAT">Flat</option>
                    <option value="PER_CAMP">Per Camp</option>
                  </select>
                </label>
              ) : (
                <label key={column.key} className="space-y-1">
                  <span className="text-[11px] uppercase tracking-wide text-bark-300">{column.label}</span>
                  <input
                    type={column.type}
                    value={row[column.key] == null ? '' : gradeAwareDisplayValue(column.key, row[column.key])}
                    onChange={(event) => onChange(field, index, column.key, event.target.value)}
                    className="w-full rounded border border-cream-300 px-2 py-1 text-xs"
                    placeholder={column.key === 'minGrade' || column.key === 'maxGrade' ? 'K' : undefined}
                  />
                </label>
              )
            ))}
          </div>
          <div className="mt-2 flex justify-end">
            <button onClick={() => onRemove(field, index)} className="text-xs text-red-500 hover:text-red-700">
              Remove row
            </button>
          </div>
        </div>
      ))}
      <button onClick={() => onAdd(field)} className="text-xs text-pine-600 hover:text-pine-700">
        Add row
      </button>
    </div>
  );
}

function gradeAwareDisplayValue(key: string, value: unknown) {
  if (key === 'minGrade' || key === 'maxGrade') return formatGradeValue(value);
  return String(value);
}

function SocialLinksEditor({
  value,
  onChange,
  className,
}: {
  value: SocialLinksValue;
  onChange: (value: unknown) => void;
  className?: string;
}) {
  const rows = Object.entries(value ?? {});
  const nextRows = rows.length ? rows : [['', '']];

  function replaceRow(index: number, key: 'platform' | 'url', nextValue: string) {
    const entries = nextRows.map(([platform, url], rowIndex) => {
      if (rowIndex !== index) return [platform, url] as const;
      return key === 'platform' ? [nextValue, url] as const : [platform, nextValue] as const;
    });
    onChange(Object.fromEntries(entries.filter(([platform, url]) => platform.trim() || url.trim())));
  }

  function addRow() {
    onChange({ ...value, '': '' });
  }

  function removeRow(index: number) {
    const entries = nextRows.filter((_, rowIndex) => rowIndex !== index);
    onChange(Object.fromEntries(entries.filter(([platform, url]) => platform.trim() || url.trim())));
  }

  return (
    <div className={cn('flex-1 space-y-2 rounded-lg border border-cream-300 bg-white p-2', className)}>
      {nextRows.map(([platform, url], index) => (
        <div key={`${platform}-${index}`} className="grid grid-cols-[minmax(0,140px)_1fr_28px] items-center gap-2">
          <input
            autoFocus={index === 0}
            value={platform}
            onChange={(event) => replaceRow(index, 'platform', event.target.value)}
            placeholder="platform"
            className="rounded border border-cream-300 px-2 py-1 text-xs"
          />
          <input
            value={url}
            onChange={(event) => replaceRow(index, 'url', event.target.value)}
            placeholder="https://..."
            className="rounded border border-cream-300 px-2 py-1 text-xs"
          />
          <button onClick={() => removeRow(index)} className="p-1 text-bark-300 hover:text-red-500">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button onClick={addRow} className="inline-flex items-center gap-1 text-xs text-pine-600 hover:text-pine-700">
        <Plus className="h-3.5 w-3.5" />
        Add social link
      </button>
    </div>
  );
}

function SocialLinksValueView({ value, highlight }: { value: SocialLinksValue; highlight?: boolean }) {
  const entries = Object.entries(value ?? {});
  if (!entries.length) return <span className="text-bark-200 italic">empty</span>;
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([platform, url]) => (
        <a
          key={`${platform}-${url}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs',
            highlight ? 'border-pine-200 bg-pine-50 text-pine-700' : 'border-cream-300 bg-cream-100 text-bark-500',
          )}
        >
          <span className="font-medium capitalize">{platform}</span>
          <ExternalLink className="h-3 w-3" />
        </a>
      ))}
    </div>
  );
}

function AgeGroupsValue({ rows, highlight }: { rows: ArrayRow[]; highlight?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {rows.map((row, index) => (
        <Badge key={`age-${index}`} highlight={highlight}>
          {row.label ? String(row.label) : 'Age Group'}
          {ageGradeSuffix(row) ? <span className="ml-1 text-bark-300">{ageGradeSuffix(row)}</span> : null}
        </Badge>
      ))}
    </div>
  );
}

function SchedulesValue({ rows, highlight }: { rows: ArrayRow[]; highlight?: boolean }) {
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div
          key={`schedule-${index}`}
          className={cn(
            'rounded-lg border px-3 py-2 text-xs',
            highlight ? 'border-pine-200 bg-pine-50 text-pine-700' : 'border-cream-300 bg-cream-100 text-bark-500',
          )}
        >
          <div className="font-medium">{String(row.label ?? 'Session')}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {dateRange(row.startDate, row.endDate) ? <span>{dateRange(row.startDate, row.endDate)}</span> : null}
            {timeRange(row.startTime, row.endTime) ? <span>{timeRange(row.startTime, row.endTime)}</span> : null}
            {row.earlyDropOff ? <span>Early drop-off: {String(row.earlyDropOff)}</span> : null}
            {row.latePickup ? <span>Late pickup: {String(row.latePickup)}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function PricingValue({ rows, highlight }: { rows: ArrayRow[]; highlight?: boolean }) {
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div
          key={`price-${index}`}
          className={cn(
            'rounded-lg border px-3 py-2 text-xs',
            highlight ? 'border-pine-200 bg-pine-50 text-pine-700' : 'border-cream-300 bg-cream-100 text-bark-500',
          )}
        >
          <div className="font-medium">{String(row.label ?? 'Pricing')}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {row.amount != null ? <span>{formatCurrency(row.amount)} {pricingUnitLabel(row.unit)}</span> : null}
            {row.durationWeeks ? <span>{String(row.durationWeeks)} week{Number(row.durationWeeks) === 1 ? '' : 's'}</span> : null}
            {row.ageQualifier ? <span>{String(row.ageQualifier)}</span> : null}
            {row.discountNotes ? <span>{String(row.discountNotes)}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function Badge({ children, highlight }: { children: ReactNode; highlight?: boolean }) {
  return (
    <span className={cn(
      'rounded-full border px-2.5 py-1 text-xs',
      highlight ? 'border-pine-200 bg-pine-50 text-pine-700' : 'border-cream-300 bg-cream-100 text-bark-500',
    )}>
      {children}
    </span>
  );
}

function ageGradeSuffix(row: ArrayRow) {
  const parts: string[] = [];
  if (row.minAge != null || row.maxAge != null) {
    if (row.minAge != null && row.maxAge != null) parts.push(`${row.minAge}–${row.maxAge} yrs`);
    else if (row.minAge != null) parts.push(`${row.minAge}+ yrs`);
    else parts.push(`up to ${row.maxAge} yrs`);
  }
  if (row.minGrade != null || row.maxGrade != null) {
    if (row.minGrade != null && row.maxGrade != null) parts.push(`Gr ${formatGradeValue(row.minGrade)}–${formatGradeValue(row.maxGrade)}`);
    else if (row.minGrade != null) parts.push(`Gr ${formatGradeValue(row.minGrade)}+`);
    else parts.push(`up to Gr ${formatGradeValue(row.maxGrade)}`);
  }
  return parts.join(' · ');
}

export function parseGradeInput(value: string): number | null {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === 'K') return 0;
  const parsed = Number(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

export function formatGradeValue(value: unknown): string {
  return Number(value) === 0 ? 'K' : String(value);
}

function dateRange(start: unknown, end: unknown) {
  if (!start && !end) return null;
  return [start, end].filter(Boolean).map((value) => (
    new Date(String(value)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  )).join(' - ');
}

function timeRange(start: unknown, end: unknown) {
  if (!start && !end) return null;
  return [start, end].filter(Boolean).map(String).join(' - ');
}

function pricingUnitLabel(unit: unknown) {
  switch (unit) {
    case 'PER_SESSION': return '/ session';
    case 'PER_DAY': return '/ day';
    case 'FLAT': return 'flat';
    case 'PER_CAMP': return '/ camp';
    default: return '/ week';
  }
}

function formatCurrency(value: unknown) {
  const amount = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(amount)) return String(value);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}
