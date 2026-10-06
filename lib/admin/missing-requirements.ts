/**
 * missing-requirements.ts — what keeps a camp from VERIFIED, in plain words.
 *
 * The admin camp page and the review page show this list for a camp that is
 * not VERIFIED, with the camp's own website and phone, so a steward can check
 * the source or call. Where a value can be entered on the spot (a session's
 * time, a single-value camp requirement), the item says so and the entry is
 * recorded as the steward's attestation (steward-entry.ts).
 *
 * `describeMissingRequirements` is pure: every requirement the derivation
 * reports as not verified yields an item, and every session requirement not
 * verified is listed under its session. Nothing derived as missing is left
 * out of the list.
 */
import type { ClaimGroupRollup } from '@kontourai/surface';

import { getPool } from '@/lib/db';
import { ENUM_OPTIONS, labelFor } from '@/lib/enums';

import { STEWARD_CAMP_FIELDS, STEWARD_FIELD_OPTIONS, type IntentionallyEmptyField, type StewardCampField } from './steward-entry';
import { deriveCampAndSessionVerification, projectTrustStatusToDataConfidence } from './verification-authority';
import type { DataConfidence } from '@/lib/types';

/** A camp-level requirement that is not verified. */
export interface MissingCampRequirement {
  readonly requirementId: string;
  readonly title: string;
  /** What is wrong and what to do, in plain words. */
  readonly detail: string;
  /** Present when a steward can enter this value in the panel. */
  readonly entry?: {
    readonly field: StewardCampField;
    readonly input: 'text' | 'textarea' | 'url' | 'select';
    readonly options?: readonly { value: string; label: string }[];
    readonly current: string | null;
  };
  /**
   * Present when the required list is empty: the steward can record, with a
   * reason, that the camp really has none. That explicit attestation is the
   * only way an empty list satisfies its requirement.
   */
  readonly intentionallyEmpty?: { readonly field: IntentionallyEmptyField };
}

/** One current session with at least one requirement not verified. */
export interface MissingSessionRequirements {
  readonly scheduleId: string;
  readonly label: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly missing: readonly { readonly attribute: string; readonly title: string; readonly detail: string }[];
  /** True when the session's time is missing: the panel offers a time entry, or "no fixed daily time" with a reason. */
  readonly timeEntry: boolean;
}

export interface MissingRequirementsGuidance {
  readonly campId: string;
  /** Derived now, not the cached column. */
  readonly dataConfidence: DataConfidence;
  readonly websiteUrl: string | null;
  readonly contactPhone: string | null;
  readonly camp: readonly MissingCampRequirement[];
  readonly sessions: readonly MissingSessionRequirements[];
}

export interface CampValuesForGuidance {
  readonly websiteUrl?: string | null;
  readonly contactPhone?: string | null;
  readonly [field: string]: unknown;
}

export interface SessionForGuidance {
  readonly id: string;
  readonly label: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly startTime: string | null;
  readonly endTime: string | null;
}

const CAMP_REQUIREMENT_TITLES: Record<string, string> = {
  description: 'Description',
  campType: 'Camp type',
  category: 'Category',
  registrationStatus: 'Registration status',
  city: 'City',
  websiteUrl: 'Website',
  ageGroups: 'Age groups',
  pricing: 'Pricing',
  'sessions-verified': 'Sessions',
};

const SESSION_ATTRIBUTE_TITLES: Record<string, string> = {
  dates: 'Dates',
  time: 'Start and end time',
  eligibility: 'Eligibility',
  'registration-status': 'Registration status',
  'price-options': 'Price options',
  'registration-path': 'Registration path',
};

/** The camp requirement an inherited session attribute follows. */
const INHERITED_FROM: Record<string, string> = {
  eligibility: 'ageGroups',
  'registration-status': 'registrationStatus',
  'price-options': 'pricing',
  'registration-path': 'websiteUrl',
};

const LIST_FIELDS = new Set(['ageGroups', 'pricing']);
/** Single values that follow a list (review apply keeps each a member of its list); checked through the list, not entered here. */
const LIST_TWINS: Record<string, string> = { campType: 'camp types', category: 'categories' };

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0);
}

function shortValue(field: string, value: unknown): string {
  if (typeof value !== 'string') return '';
  const shown = ENUM_OPTIONS[field] ? labelFor(field, value) : value;
  return shown.length > 60 ? `${shown.slice(0, 57)}…` : shown;
}

function campDetail(requirementId: string, status: string, value: unknown): string {
  const stale = status === 'stale';
  if (requirementId === 'pricing' && isEmpty(value)) {
    // The camp editor has no price editor. Mark Verified does not attest an
    // empty list, so it is not offered here.
    return 'No prices listed. Find them on the camp\'s website or call; prices come in through a crawl a reviewer approves. If the camp really charges nothing, record that here with how you know.';
  }
  if (LIST_FIELDS.has(requirementId)) {
    if (isEmpty(value)) return 'None listed. Find them on the camp\'s website or call, then add them in the camp editor. If the camp really has none, record that here with how you know.';
    return stale
      ? 'Checked, but too long ago. Check the list against the camp\'s website again, then attest it in the camp editor.'
      : 'Listed, but nobody has checked the list against the source yet. Approve it in review, or check it and attest it in the camp editor.';
  }
  const list = LIST_TWINS[requirementId];
  if (list) {
    return isEmpty(value)
      ? `No value yet. Find it on the camp's website or call, then set the camp's ${list} in the camp editor and attest it.`
      : `Not checked against the source yet. Approve the proposed ${list} in review, or check them and attest in the camp editor.`;
  }
  if (isEmpty(value)) return 'No value yet. Find it on the camp\'s website or call, then enter it here.';
  const shown = shortValue(requirementId, value);
  return stale
    ? `Checked, but too long ago${shown ? ` (now "${shown}")` : ''}. Check it again, then confirm or correct it here.`
    : `Has a value${shown ? ` ("${shown}")` : ''} that nobody has checked against the source yet. Check it, then confirm or correct it here.`;
}

function sessionDetail(attribute: string, session: SessionForGuidance, campMissing: ReadonlySet<string>): string {
  if (attribute === 'time') {
    return session.startTime && session.endTime
      ? `${session.startTime}–${session.endTime} has not been checked against the source. Check it, then enter it here.`
      : 'The crawled page does not state when this session starts and ends. Check the website or call, then enter it here, or record that it has no fixed daily time (an overnight or residential session).';
  }
  if (attribute === 'dates') return 'The dates have not been checked against the source. Approve the session list in review.';
  const from = INHERITED_FROM[attribute];
  if (from) {
    const title = CAMP_REQUIREMENT_TITLES[from] ?? from;
    return campMissing.has(from)
      ? `Follows the camp's ${title.toLowerCase()}, which is not checked yet (listed above).`
      : `Follows the camp's ${title.toLowerCase()}.`;
  }
  return 'Not checked yet.';
}

/**
 * Plain-words guidance for every requirement the derivation reports as not
 * verified. `sessionRollups` holds each current session's own rollup.
 */
export function describeMissingRequirements(input: {
  readonly campId: string;
  readonly campRollup: Pick<ClaimGroupRollup, 'status' | 'requirements'>;
  readonly camp: CampValuesForGuidance;
  readonly sessions: readonly { readonly session: SessionForGuidance; readonly rollup: Pick<ClaimGroupRollup, 'requirements'> }[];
}): MissingRequirementsGuidance {
  const missingCamp = input.campRollup.requirements.filter((requirement) => requirement.status !== 'verified');
  const campMissingIds = new Set(missingCamp.map((requirement) => requirement.id));

  const sessions: MissingSessionRequirements[] = [];
  for (const { session, rollup } of input.sessions) {
    const missing = rollup.requirements
      .filter((requirement) => requirement.status !== 'verified')
      .map((requirement) => ({
        attribute: requirement.id,
        title: SESSION_ATTRIBUTE_TITLES[requirement.id] ?? requirement.title ?? requirement.id,
        detail: sessionDetail(requirement.id, session, campMissingIds),
      }));
    if (missing.length === 0) continue;
    sessions.push({
      scheduleId: session.id,
      label: session.label,
      startDate: session.startDate,
      endDate: session.endDate,
      startTime: session.startTime,
      endTime: session.endTime,
      missing,
      timeEntry: missing.some((item) => item.attribute === 'time'),
    });
  }

  const camp: MissingCampRequirement[] = missingCamp.map((requirement) => {
    const title = CAMP_REQUIREMENT_TITLES[requirement.id] ?? requirement.title ?? requirement.id;
    if (requirement.id === 'sessions-verified') {
      const count = sessions.length;
      if (input.sessions.length === 0) {
        return {
          requirementId: requirement.id,
          title,
          detail: 'No sessions listed. Find them on the camp\'s website or call; sessions come in through a crawl a reviewer approves. If the camp really runs no sessions, record that here with how you know.',
          intentionallyEmpty: { field: 'schedules' },
        } satisfies MissingCampRequirement;
      }
      return {
        requirementId: requirement.id,
        title,
        detail: count > 0
          ? `${count} session${count === 1 ? ' is' : 's are'} not fully checked (listed below).`
          : 'The sessions are not fully checked yet.',
      };
    }
    const value = input.camp[requirement.id];
    const field = (STEWARD_CAMP_FIELDS as readonly string[]).includes(requirement.id) ? (requirement.id as StewardCampField) : null;
    const options = field ? STEWARD_FIELD_OPTIONS[field] : undefined;
    return {
      requirementId: requirement.id,
      title,
      detail: campDetail(requirement.id, requirement.status, value),
      ...(LIST_FIELDS.has(requirement.id) && isEmpty(value) ? { intentionallyEmpty: { field: requirement.id as IntentionallyEmptyField } } : {}),
      ...(field
        ? {
            entry: {
              field,
              input: options ? 'select' : field === 'description' ? 'textarea' : field === 'websiteUrl' ? 'url' : 'text',
              ...(options ? { options } : {}),
              current: typeof value === 'string' ? value : null,
            },
          }
        : {}),
    } satisfies MissingCampRequirement;
  });

  return {
    campId: input.campId,
    dataConfidence: projectTrustStatusToDataConfidence(input.campRollup.status),
    websiteUrl: typeof input.camp.websiteUrl === 'string' && input.camp.websiteUrl.trim() ? input.camp.websiteUrl : null,
    contactPhone: typeof input.camp.contactPhone === 'string' && input.camp.contactPhone.trim() ? input.camp.contactPhone : null,
    camp,
    sessions,
  };
}

/**
 * Load the guidance for one camp, or null when the camp does not exist. Reads
 * through the pool and holds no connection across reads (a page render, not a
 * writer).
 */
export async function loadMissingRequirements(campId: string): Promise<MissingRequirementsGuidance | null> {
  const pool = getPool();
  const { rows: campRows } = await pool.query<CampValuesForGuidance>(`SELECT * FROM "Camp" WHERE id = $1`, [campId]);
  const campRow = campRows[0];
  if (!campRow) return null;
  const [ageGroups, pricing, sessionRows] = await Promise.all([
    pool.query(`SELECT id FROM "CampAgeGroup" WHERE "campId" = $1`, [campId]),
    pool.query(`SELECT id FROM "CampPricing" WHERE "campId" = $1`, [campId]),
    pool.query<SessionForGuidance>(
      `SELECT id, label, to_char("startDate", 'YYYY-MM-DD') AS "startDate", to_char("endDate", 'YYYY-MM-DD') AS "endDate", "startTime", "endTime"
         FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL ORDER BY "startDate" ASC NULLS LAST, id`,
      [campId],
    ),
  ]);
  // One bundle and one derivation for the camp and all its sessions.
  const derived = await deriveCampAndSessionVerification(campId);
  const campRollup = derived.camp;
  const sessions = sessionRows.rows.flatMap((session) => {
    const rollup = derived.sessions.get(session.id);
    // A session archived between the two reads is no longer the camp's.
    return rollup ? [{ session, rollup }] : [];
  });
  return describeMissingRequirements({
    campId,
    campRollup,
    camp: { ...campRow, ageGroups: ageGroups.rows, pricing: pricing.rows },
    sessions,
  });
}
