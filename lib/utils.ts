import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function getLowestPrice(
  pricing: { amount: number }[]
): number | null {
  if (pricing.length === 0) return null;
  return Math.min(...pricing.map((p) => p.amount));
}

export function getAgeRangeSummary(
  ageGroups: { minAge: number | null; maxAge: number | null; label: string }[]
): string {
  if (ageGroups.length === 0) return "All ages";
  if (ageGroups.length === 1) return ageGroups[0].label;

  const allAges = ageGroups.flatMap((g) => [g.minAge, g.maxAge].filter(Boolean));
  if (allAges.length === 0) return ageGroups.map((g) => g.label).join(", ");

  const min = Math.min(...(allAges as number[]));
  const max = Math.max(...(allAges as number[]));
  return `Ages ${min}-${max}`;
}
