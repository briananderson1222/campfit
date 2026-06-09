export const CAMPFIT_TIME_ZONE = 'America/Denver';

type DateInput = Date | string | number;

export function formatCampDate(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' },
): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CAMPFIT_TIME_ZONE,
    ...options,
  }).format(normalizeDateInput(value));
}

export function formatCampDateTime(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  },
): string {
  return formatCampDate(value, options);
}

function normalizeDateInput(value: DateInput): Date {
  if (typeof value === 'string') {
    const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
      const [, year, month, day] = dateOnly;
      return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
    }
  }
  return new Date(value);
}
