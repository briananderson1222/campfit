/**
 * Category classifier for Denver Camps CSV data.
 *
 * Maps the 20+ raw CSV category values to our normalized CampCategory enum.
 *
 * Raw categories observed:
 *   Sports, Performing Arts, Outdoors, Cooking, Art, Art - Ceramics,
 *   Dance, STEM/STEAM, Language, Science, Animals & Nature,
 *   Education Performance, Education/ Business, Variety,
 *   Variety and Science, Traditional Day Camp, Musical Theater/Dance,
 *   Arts/Theater, Preschool Play Based Camp, General/Themed,
 *   Fashion/Sewing, Math/Reading Tutoring
 */

import { CampCategory } from "@/lib/types";

const CATEGORY_MAP: Record<string, CampCategory> = {
  // Sports
  sports: "SPORTS",
  sport: "SPORTS",
  "multi-sport": "SPORTS",
  multisport: "SPORTS",
  athletic: "SPORTS",
  athletics: "SPORTS",
  "all sports": "SPORTS",
  gymnastics: "SPORTS",

  // Arts
  art: "ARTS",
  arts: "ARTS",
  "art - ceramics": "ARTS",
  "arts & crafts": "ARTS",
  "arts/crafts": "ARTS",
  craft: "ARTS",
  crafts: "ARTS",
  "fashion/sewing": "ARTS",
  sewing: "ARTS",
  fashion: "ARTS",
  ceramics: "ARTS",

  // STEM
  stem: "STEM",
  steam: "STEM",
  "stem/steam": "STEM",
  science: "STEM",
  technology: "STEM",
  engineering: "STEM",
  math: "STEM",
  coding: "STEM",
  robotics: "STEM",
  "math/reading tutoring": "ACADEMIC",
  "variety and science": "STEM",

  // Nature
  outdoors: "NATURE",
  outdoor: "NATURE",
  nature: "NATURE",
  "animals & nature": "NATURE",
  animals: "NATURE",
  adventure: "NATURE",
  wilderness: "NATURE",
  hiking: "NATURE",
  farming: "NATURE",

  // Academic
  academic: "ACADEMIC",
  "education performance": "ACADEMIC",
  "education/ business": "ACADEMIC",
  "education/business": "ACADEMIC",
  education: "ACADEMIC",
  tutoring: "ACADEMIC",
  reading: "ACADEMIC",
  language: "ACADEMIC",
  french: "ACADEMIC",
  spanish: "ACADEMIC",
  chinese: "ACADEMIC",

  // Music
  music: "MUSIC",
  "music camp": "MUSIC",
  "rock band": "MUSIC",

  // Theater
  theater: "THEATER",
  theatre: "THEATER",
  drama: "THEATER",
  "performing arts": "THEATER",
  "musical theater": "THEATER",
  "musical theatre": "THEATER",
  "musical theater/dance": "THEATER",
  "arts/theater": "THEATER",
  "arts/theatre": "THEATER",
  improv: "THEATER",

  // Cooking
  cooking: "COOKING",
  culinary: "COOKING",
  baking: "COOKING",

  // Multi-Activity
  variety: "MULTI_ACTIVITY",
  "traditional day camp": "MULTI_ACTIVITY",
  "day camp": "MULTI_ACTIVITY",
  "general/themed": "MULTI_ACTIVITY",
  "preschool play based camp": "MULTI_ACTIVITY",
  "play based": "MULTI_ACTIVITY",
  general: "MULTI_ACTIVITY",
  themed: "MULTI_ACTIVITY",

  // Dance → map to theater (performing arts adjacent)
  dance: "THEATER",
};

/**
 * Classify a raw category string into our normalized enum.
 * Falls back to OTHER if no match found.
 */
export function classifyCategory(raw: string): CampCategory {
  if (!raw || !raw.trim()) return "OTHER";

  const lower = raw.trim().toLowerCase();

  // Direct lookup
  if (CATEGORY_MAP[lower]) {
    return CATEGORY_MAP[lower];
  }

  // Partial match — check if any key is a substring
  for (const [key, category] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(key) || key.includes(lower)) {
      return category;
    }
  }

  return "OTHER";
}

/**
 * Try to infer category from camp name and description
 * when the category field is missing or "Other".
 */
export function inferCategoryFromText(
  name: string,
  description: string
): CampCategory {
  const text = `${name} ${description}`.toLowerCase();

  const signals: [CampCategory, RegExp[]][] = [
    [
      "SPORTS",
      [
        /\b(?:soccer|basketball|baseball|football|tennis|swimming|lacrosse|volleyball|hockey|golf|martial\s*arts|karate|fencing|climbing|gymnastics)\b/,
        /\bmulti-?sport\b/,
        /\bathletic\b/,
      ],
    ],
    [
      "STEM",
      [
        /\b(?:coding|programming|robotics|minecraft|roblox|3d\s*print|drone|circuit|engineer|computer|cyber|ai|machine\s*learning)\b/,
        /\bstem\b/,
        /\bsteam\b/,
        /\bscience\b/,
      ],
    ],
    [
      "NATURE",
      [
        /\b(?:hiking|nature|wilderness|wildlife|outdoor|camping|ecology|garden|farm|horse|equestrian|fishing)\b/,
        /\btrail\b/,
        /\bmountain\b/,
      ],
    ],
    [
      "ARTS",
      [
        /\b(?:painting|drawing|sculpture|ceramics|pottery|printmaking|mixed\s*media|art\s*studio|fiber\s*art|weaving|sewing)\b/,
      ],
    ],
    [
      "THEATER",
      [
        /\b(?:theater|theatre|acting|improv|musical|drama|perform|stage|playwriting|dance|ballet|hip\s*hop|choreograph)\b/,
      ],
    ],
    [
      "MUSIC",
      [
        /\b(?:music|band|orchestra|guitar|piano|drum|singing|choir|song|instrument|jazz|rock\s*band)\b/,
      ],
    ],
    [
      "COOKING",
      [
        /\b(?:cooking|culinary|baking|chef|kitchen|recipe|cuisine)\b/,
      ],
    ],
    [
      "ACADEMIC",
      [
        /\b(?:tutor|reading|writing|math|language|french|spanish|chinese|mandarin|sat\s*prep|test\s*prep|homework|study)\b/,
      ],
    ],
  ];

  for (const [category, patterns] of signals) {
    for (const pattern of patterns) {
      if (pattern.test(text)) return category;
    }
  }

  return "MULTI_ACTIVITY"; // default for camps without clear category signals
}
