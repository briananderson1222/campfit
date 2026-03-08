/**
 * DataIngestionAdapter — the core abstraction for all data sources.
 *
 * Phase 1: CsvIngestionAdapter (seed from CSV files)
 * Phase 4: ScraperIngestionAdapter (per-site web scrapers)
 * Future:  GoogleSheetAdapter, ProviderFormAdapter
 */

import {
  CampType,
  CampCategory,
  RegistrationStatus,
  DataConfidence,
  PricingUnit,
} from "@/lib/types";

export type SourceType = "CSV" | "SCRAPER" | "MANUAL" | "PROVIDER_FORM";

export interface CampInput {
  slug: string;
  name: string;
  description: string;
  notes: string | null;
  campType: CampType;
  category: CampCategory;
  websiteUrl: string;
  interestingDetails: string | null;

  city: string;
  region: string | null;
  neighborhood: string;
  address: string;
  latitude: number | null;
  longitude: number | null;

  lunchIncluded: boolean;

  registrationOpenDate: string | null;
  registrationOpenTime: string | null;
  registrationStatus: RegistrationStatus;

  sourceType: SourceType;
  sourceUrl: string | null;
  dataConfidence: DataConfidence;

  ageGroups: {
    label: string;
    minAge: number | null;
    maxAge: number | null;
    minGrade: number | null;
    maxGrade: number | null;
  }[];

  schedules: {
    label: string;
    startDate: string;
    endDate: string;
    startTime: string | null;
    endTime: string | null;
    earlyDropOff: string | null;
    latePickup: string | null;
  }[];

  pricing: {
    label: string;
    amount: number;
    unit: PricingUnit;
    durationWeeks: number | null;
    ageQualifier: string | null;
    discountNotes: string | null;
  }[];
}

export interface IngestionResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; name: string; error: string }[];
}

export interface DataIngestionAdapter {
  readonly sourceType: SourceType;
  fetch(): Promise<Record<string, string>[]>;
  normalize(raw: Record<string, string>): CampInput | null;
  ingest(): Promise<IngestionResult>;
}
