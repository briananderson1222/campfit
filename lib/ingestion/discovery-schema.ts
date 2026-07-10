import type { TargetFieldSchema } from "@kontourai/traverse";

export const DISCOVERY_ITEMS_PREFIX = "items[].";

export const DISCOVERY_TARGET_SCHEMA: TargetFieldSchema[] = [
  {
    path: "items[].name",
    type: "string",
    required: true,
    description: "One distinct camp program name, never the page or provider title.",
  },
  {
    path: "items[].detailUrl",
    type: "string",
    description: "The program's own detail/info link visible in Markdown as [label](href), never a registration URL.",
  },
  {
    path: "items[].snippet",
    type: "string",
    description: "A short verbatim description of this program from the listing, never a generated summary.",
  },
];

export const DISCOVERY_FIELD_HINTS: Record<string, string> = {
  "items[].name": "Extract every distinct named program as its own item. Do not split sessions or weeks of one program.",
  "items[].detailUrl": "Use only a grounded href from the same program's Markdown link excerpt. Exclude register/enroll/application links.",
  "items[].snippet": "Copy listing text verbatim. Omit this field when no short descriptive excerpt exists.",
};
