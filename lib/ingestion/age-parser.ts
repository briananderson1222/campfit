/**
 * Age/grade parser for Denver Camps CSV data.
 *
 * Handles formats like:
 *   "6 to teen"
 *   "Ages 3-5", "ages 4-12", "Age 3-12"
 *   "3-7 year olds", "4-14 yrs"
 *   "PreK-12th grade"
 *   "rising Kindergarten - 2nd grade"
 *   "K - 5th Grade", "Grades 1-5"
 *   "1st-12th grade", "2nd - 5th grades"
 *   "rising 3rd - 8th grades"
 *   "Completed 2nd through 11th grade"
 *   "9-16" (bare age range)
 *   "Y", "N", "No", "" (non-age markers in age columns)
 *   Per-column age markers like "6 to teen" in individual grade columns
 */

export interface ParsedAgeGroup {
  label: string;
  minAge: number | null;
  maxAge: number | null;
  minGrade: number | null; // -1=PreK, 0=K, 1=1st, etc.
  maxGrade: number | null;
}

const GRADE_WORDS: Record<string, number> = {
  prek: -1,
  "pre-k": -1,
  preschool: -1,
  kindergarten: 0,
  k: 0,
};

const ORDINAL_RE = /(\d+)(?:st|nd|rd|th)/;

/**
 * Parse the main "Ages/Grades" field from the CSV.
 * Returns one or more age groups (camps may serve multiple ranges).
 */
export function parseAgeGroups(raw: string): ParsedAgeGroup[] {
  if (!raw || !raw.trim()) return [];

  const cleaned = raw.trim();
  const lower = cleaned.toLowerCase();

  // Skip non-age values
  if (
    lower === "y" ||
    lower === "n" ||
    lower === "no" ||
    lower === "yes" ||
    lower === "x" ||
    lower === "all" ||
    lower === "tbd" ||
    lower === ""
  ) {
    if (lower === "all") {
      return [{ label: "All ages", minAge: 3, maxAge: 18, minGrade: -1, maxGrade: 12 }];
    }
    return [];
  }

  // Check for multiple comma-separated groups (e.g., "No, 1st - 12th grade, 3 year old through 5th Grade")
  const segments = cleaned.split(/,\s*/).filter((s) => {
    const sl = s.trim().toLowerCase();
    return sl && sl !== "no" && sl !== "n" && sl !== "yes" && sl !== "y";
  });

  if (segments.length > 1) {
    const results: ParsedAgeGroup[] = [];
    for (const seg of segments) {
      const parsed = parseSingleAgeGroup(seg.trim());
      if (parsed) results.push(parsed);
    }
    return results.length > 0 ? results : [];
  }

  const parsed = parseSingleAgeGroup(cleaned);
  return parsed ? [parsed] : [];
}

function parseSingleAgeGroup(raw: string): ParsedAgeGroup | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;

  const lower = cleaned.toLowerCase()
    .replace(/\*verify\*\s*/i, "")
    .replace(/discrepancy\s*/i, "")
    .trim();

  // 1. "teen" patterns: "6 to teen", "Age 6-teen"
  const teenMatch = lower.match(/(?:ages?\s*)?(\d+)\s*(?:to|-)\s*teen/);
  if (teenMatch) {
    const minAge = parseInt(teenMatch[1]);
    return {
      label: `Ages ${minAge}-teen`,
      minAge,
      maxAge: 17,
      minGrade: ageToGrade(minAge),
      maxGrade: 12,
    };
  }

  // 2. Grade ranges: "PreK-12th grade", "K - 5th Grade", "1st-12th grade"
  //    Also: "rising Kindergarten - 2nd grade", "rising 3rd - 8th grades"
  //    Also: "Completed 2nd through 11th grade"
  const gradeRange = parseGradeRange(lower);
  if (gradeRange) {
    return {
      label: buildGradeLabel(gradeRange.minGrade, gradeRange.maxGrade),
      minAge: gradeToAge(gradeRange.minGrade),
      maxAge: gradeToAge(gradeRange.maxGrade) + 1,
      minGrade: gradeRange.minGrade,
      maxGrade: gradeRange.maxGrade,
    };
  }

  // 3. Simple age ranges: "Ages 3-5", "ages 4-12", "3-7 year olds", "9-16"
  const ageRange = parseAgeRange(lower);
  if (ageRange) {
    return {
      label: `Ages ${ageRange.min}-${ageRange.max}`,
      minAge: ageRange.min,
      maxAge: ageRange.max,
      minGrade: ageToGrade(ageRange.min),
      maxGrade: ageToGrade(ageRange.max),
    };
  }

  // 4. Single grade: "Kindergarten", "PreK"
  for (const [word, grade] of Object.entries(GRADE_WORDS)) {
    if (lower === word || lower === `${word} only`) {
      return {
        label: grade === -1 ? "PreK" : grade === 0 ? "Kindergarten" : `Grade ${grade}`,
        minAge: gradeToAge(grade),
        maxAge: gradeToAge(grade) + 1,
        minGrade: grade,
        maxGrade: grade,
      };
    }
  }

  // 5. Single age: "age 5", "5 year olds"
  const singleAge = lower.match(/(?:ages?\s*)?(\d+)\s*(?:year\s*old|yr|yo)?s?\s*$/);
  if (singleAge) {
    const age = parseInt(singleAge[1]);
    if (age >= 2 && age <= 18) {
      return {
        label: `Age ${age}`,
        minAge: age,
        maxAge: age,
        minGrade: ageToGrade(age),
        maxGrade: ageToGrade(age),
      };
    }
  }

  // 6. Fallback — just return the raw text as label
  return {
    label: cleaned,
    minAge: null,
    maxAge: null,
    minGrade: null,
    maxGrade: null,
  };
}

function parseGradeRange(lower: string): { minGrade: number; maxGrade: number } | null {
  // Remove qualifiers
  const normalized = lower
    .replace(/rising\s+/g, "")
    .replace(/completed\s+/g, "")
    .replace(/entering\s+/g, "")
    .replace(/grades?\s*/g, "")
    .replace(/\s*grades?$/g, "")
    .trim();

  // Match "prek - 12th", "k - 5th", "1st - 8th", "1st-12th"
  const parts = normalized.split(/\s*(?:through|thru|to|-|–)\s*/);
  if (parts.length !== 2) return null;

  const minGrade = parseGradeToken(parts[0].trim());
  const maxGrade = parseGradeToken(parts[1].trim());

  if (minGrade === null || maxGrade === null) return null;
  if (minGrade > maxGrade) return null;

  return { minGrade, maxGrade };
}

function parseGradeToken(token: string): number | null {
  // Check named grades
  for (const [word, grade] of Object.entries(GRADE_WORDS)) {
    if (token === word || token.startsWith(word)) return grade;
  }

  // Check ordinal: "1st", "2nd", "3rd", "5th", "12th"
  const ordinalMatch = token.match(ORDINAL_RE);
  if (ordinalMatch) return parseInt(ordinalMatch[1]);

  // Check bare number (could be grade or age — assume grade if <= 12)
  const num = parseInt(token);
  if (!isNaN(num) && num >= 0 && num <= 12) return num;

  return null;
}

function parseAgeRange(lower: string): { min: number; max: number } | null {
  // "ages 3-5", "age 3-12", "3-7 year olds", "4-14 yrs", "9-16"
  const match = lower.match(
    /(?:ages?\s*)?(\d+)\s*(?:to|-|–)\s*(\d+)(?:\s*(?:year\s*old|yr|yo)s?)?/
  );
  if (!match) return null;

  const min = parseInt(match[1]);
  const max = parseInt(match[2]);

  // Sanity check — must look like ages (not prices, not years)
  if (min < 1 || min > 18 || max < 1 || max > 18) return null;
  if (min > max) return null;

  return { min, max };
}

/**
 * Parse age group markers from individual grade columns.
 * In the CSV, columns like "PreK", "Kindergarten (ages 5-6)", "1st-2nd Grades" etc.
 * contain "Y", "No", or an age string like "6 to teen".
 */
export function parseColumnAgeMarker(
  columnName: string,
  value: string
): ParsedAgeGroup | null {
  const lower = value.trim().toLowerCase();

  // Skip empty/no values
  if (!lower || lower === "no" || lower === "n" || lower === "" || lower === "x") {
    return null;
  }

  // If value is "Y" or "Yes", derive age from the column name
  if (lower === "y" || lower === "yes") {
    return parseColumnNameToAgeGroup(columnName);
  }

  // Otherwise the value itself is an age description (e.g., "6 to teen")
  const parsed = parseSingleAgeGroup(value);
  return parsed;
}

function parseColumnNameToAgeGroup(columnName: string): ParsedAgeGroup | null {
  const lower = columnName.toLowerCase();

  if (lower.includes("prek") || lower.includes("pre-k")) {
    return { label: "PreK", minAge: 3, maxAge: 4, minGrade: -1, maxGrade: -1 };
  }
  if (lower.includes("kindergarten")) {
    return { label: "Kindergarten", minAge: 5, maxAge: 6, minGrade: 0, maxGrade: 0 };
  }

  // "1st-2nd Grades (Ages 6-8)"
  const gradeAgeMatch = lower.match(
    /(\d+)(?:st|nd|rd|th)-(\d+)(?:st|nd|rd|th)\s*grade.*?(?:ages?\s*)?(\d+)-(\d+)/
  );
  if (gradeAgeMatch) {
    return {
      label: `Grades ${gradeAgeMatch[1]}-${gradeAgeMatch[2]}`,
      minAge: parseInt(gradeAgeMatch[3]),
      maxAge: parseInt(gradeAgeMatch[4]),
      minGrade: parseInt(gradeAgeMatch[1]),
      maxGrade: parseInt(gradeAgeMatch[2]),
    };
  }

  // "9th and 10th Grades (ages 13-16)"
  const andGradeMatch = lower.match(
    /(\d+)(?:st|nd|rd|th)\s*and\s*(\d+)(?:st|nd|rd|th)\s*grade.*?(\d+)-(\d+)/
  );
  if (andGradeMatch) {
    return {
      label: `Grades ${andGradeMatch[1]}-${andGradeMatch[2]}`,
      minAge: parseInt(andGradeMatch[3]),
      maxAge: parseInt(andGradeMatch[4]),
      minGrade: parseInt(andGradeMatch[1]),
      maxGrade: parseInt(andGradeMatch[2]),
    };
  }

  return null;
}

// ─── Helpers ─────────────────────────────────────────────

function gradeToAge(grade: number): number {
  // PreK=-1 → 3, K=0 → 5, 1st=1 → 6, etc.
  if (grade === -1) return 3;
  return grade + 5;
}

function ageToGrade(age: number): number {
  if (age <= 4) return -1;
  if (age <= 5) return 0;
  return Math.min(age - 5, 12);
}

function buildGradeLabel(minGrade: number, maxGrade: number): string {
  const gradeStr = (g: number): string => {
    if (g === -1) return "PreK";
    if (g === 0) return "K";
    if (g === 1) return "1st";
    if (g === 2) return "2nd";
    if (g === 3) return "3rd";
    return `${g}th`;
  };

  if (minGrade === maxGrade) return `Grade ${gradeStr(minGrade)}`;
  return `Grades ${gradeStr(minGrade)}-${gradeStr(maxGrade)}`;
}
