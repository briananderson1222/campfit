import type { ExtractionProposal } from "@kontourai/traverse";
import { safeExternalHref } from "@/lib/admin/safe-url";
import { DISCOVERY_ITEMS_PREFIX } from "./discovery-schema";
import { assignGlobalItemIndices } from "./traverse-item-grouping";

export interface GroupedDiscoveryItem {
  name: string;
  detailUrl: string | null;
  snippet: string | null;
  excerpt: string;
  locator: string;
  nameExcerpt: string;
  nameLocator: string;
  detailUrlExcerpt: string | null;
  detailUrlLocator: string | null;
}

type Field = "name" | "detailUrl" | "snippet";
const FIELDS = new Set<Field>(["name", "detailUrl", "snippet"]);
const DEDUPE_THRESHOLD = 0.75;

function bigrams(value: string): Set<string> {
  // Keep this byte-for-byte equivalent to llm-discovery's preserved Dice
  // normalization: punctuation removal, whitespace collapse, and Set bigrams.
  const normalized = value.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index++) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

function diceCoefficient(left: string, right: string): number {
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) return 0;
  let intersection = 0;
  leftBigrams.forEach((gram) => {
    if (rightBigrams.has(gram)) intersection++;
  });
  return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
}

export function groupDiscoveryItems(
  proposals: ExtractionProposal[],
  finalUrl: string,
): { items: GroupedDiscoveryItem[]; warnings: string[] } {
  const filtered = proposals.filter((proposal) => {
    if (!proposal.fieldPath.startsWith(DISCOVERY_ITEMS_PREFIX)) return false;
    return FIELDS.has(proposal.fieldPath.slice(DISCOVERY_ITEMS_PREFIX.length) as Field);
  });
  const { items: indexedProposals, chunkBoundaryIndices } = assignGlobalItemIndices(filtered);
  const groups = new Map<number, Partial<Record<Field, ExtractionProposal>>>();
  for (const { globalIndex, proposal } of indexedProposals) {
    const field = proposal.fieldPath.slice(DISCOVERY_ITEMS_PREFIX.length) as Field;
    groups.set(globalIndex, { ...(groups.get(globalIndex) ?? {}), [field]: proposal });
  }

  const warnings: string[] = [];
  const items: GroupedDiscoveryItem[] = [];
  for (const [index, fields] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (chunkBoundaryIndices.has(index)) {
      warnings.push(
        `items[${index}] was rebased across a traverse chunk boundary (the provider's raw pathIndices[0] restarted for a later chunk)`,
      );
    }
    const name = String(fields.name?.candidateValue ?? "").trim();
    const nameExcerpt = fields.name?.provenance.excerpt ?? "";
    const nameLocator = fields.name?.provenance.locator ?? "";
    if (!name || !nameExcerpt.includes(name) || !/^chars:\d+-\d+$/.test(nameLocator)) {
      warnings.push(`items[${index}] dropped: missing verified name provenance`);
      continue;
    }
    if (items.some((item) => diceCoefficient(name, item.name) >= DEDUPE_THRESHOLD)) continue;

    let detailUrl: string | null = null;
    let detailUrlExcerpt: string | null = null;
    let detailUrlLocator: string | null = null;
    const rawUrl = String(fields.detailUrl?.candidateValue ?? "").trim();
    if (rawUrl) {
      const linkExcerpt = fields.detailUrl?.provenance.excerpt ?? "";
      const linkLocator = fields.detailUrl?.provenance.locator ?? "";
      if (linkExcerpt.includes(`](${rawUrl})`) && /^chars:\d+-\d+$/.test(linkLocator)) {
        try {
          detailUrl = safeExternalHref(new URL(rawUrl, finalUrl).toString()) ?? null;
          if (detailUrl) {
            detailUrlExcerpt = linkExcerpt;
            detailUrlLocator = linkLocator;
          }
        } catch {
          detailUrl = null;
        }
      }
      if (!detailUrl) warnings.push(`items[${index}].detailUrl dropped: ungrounded, unsafe, or invalid URL`);
    }

    const snippet = String(fields.snippet?.candidateValue ?? "").trim();
    const snippetExcerpt = fields.snippet?.provenance.excerpt ?? "";
    const snippetLocator = fields.snippet?.provenance.locator ?? "";
    const verifiedSnippet = snippet && snippetExcerpt.includes(snippet) && /^chars:\d+-\d+$/.test(snippetLocator);
    if (snippet && !verifiedSnippet) warnings.push(`items[${index}].snippet dropped: not verbatim`);
    items.push({
      name,
      detailUrl,
      snippet: verifiedSnippet ? snippet : null,
      excerpt: verifiedSnippet ? snippetExcerpt : nameExcerpt,
      locator: verifiedSnippet ? snippetLocator : nameLocator,
      nameExcerpt,
      nameLocator,
      detailUrlExcerpt,
      detailUrlLocator,
    });
  }
  return { items, warnings };
}
