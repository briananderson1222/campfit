/**
 * The two digests a crawl proposal rests on: the prepared-text identity an
 * excerpt is checked against, and the content fingerprint a re-crawl may skip
 * extraction on. Each guard below is one a silent revert would otherwise pass.
 */
import { describe, expect, it } from "vitest";
import { createPreparedArtifact, prepareAndChunk } from "@kontourai/traverse";

import { resolveCitationText } from "@/lib/admin/citation-text";
import { fingerprintPreparedText } from "@/lib/ingestion/content-fingerprint";
import { CAMP_FIELD_HINTS, CAMP_TARGET_SCHEMA } from "@/lib/ingestion/traverse-schema";
import { listingHtml } from "../fixtures/real-crawl/replay";

const SNAPSHOT_REF = "traverse-snapshot:camp-1?url=https%3A%2F%2Fpineridge.example%2Fdates-rates&sha256=" + "a".repeat(64) + "&fetchedAt=2026-10-01T00%3A00%3A00.000Z";
const body = listingHtml();
const snapshot = { body, contentType: "html" as const };
const preparedText = prepareAndChunk(body, "html").fullText;
const recorded = createPreparedArtifact(preparedText, { preparationMode: "markdown", sourceSnapshotRef: SNAPSHOT_REF });

describe("the text citations are checked against", () => {
  it("is the prepared text when the recorded digest reproduces from the snapshot", () => {
    const citation = resolveCitationText({ snapshotRef: SNAPSHOT_REF, snapshot, preparedArtifact: recorded });
    expect(citation).toMatchObject({ ok: true, space: "prepared", text: preparedText });
    expect(preparedText).toContain("**First Session:** June 6th - June 20th, 2027");
    expect(body).not.toContain("**First Session:**");
  });

  it("is refused when the recorded digest is not the digest of this snapshot's prepared text", () => {
    // A record of some other text, still claiming this snapshot.
    const other = createPreparedArtifact(`${preparedText}\nRegistration is now closed.`, { preparationMode: "markdown", sourceSnapshotRef: SNAPSHOT_REF });
    const citation = resolveCitationText({ snapshotRef: SNAPSHOT_REF, snapshot, preparedArtifact: other });
    expect(citation).toMatchObject({ ok: false, reason: "digest-mismatch" });
  });

  it("is refused when the record names a different snapshot", () => {
    const elsewhere = createPreparedArtifact(preparedText, { preparationMode: "markdown", sourceSnapshotRef: SNAPSHOT_REF.replace("camp-1", "camp-2") });
    const citation = resolveCitationText({ snapshotRef: SNAPSHOT_REF, snapshot, preparedArtifact: elsewhere });
    expect(citation).toMatchObject({ ok: false, reason: "snapshot-mismatch" });
  });

  it("is refused when the record was altered after it was written", () => {
    const citation = resolveCitationText({ snapshotRef: SNAPSHOT_REF, snapshot, preparedArtifact: { ...recorded, contentLength: recorded.contentLength + 1 } });
    expect(citation.ok).toBe(false);
  });

  it("is the raw body only for a proposal that recorded no prepared text", () => {
    expect(resolveCitationText({ snapshotRef: SNAPSHOT_REF, snapshot })).toEqual({ ok: true, space: "snapshot-body", text: body });
  });
});

describe("the content fingerprint", () => {
  const request = { targetSchema: CAMP_TARGET_SCHEMA, fieldHints: CAMP_FIELD_HINTS, provider: "relay-extraction-provider:codex:gpt-6.1-sol" };
  const base = fingerprintPreparedText(preparedText, request);

  it("is stable for the same text and request", () => {
    expect(fingerprintPreparedText(preparedText, { ...request, fieldHints: { ...CAMP_FIELD_HINTS } })).toBe(base);
  });

  it("changes when the schema changes", () => {
    expect(fingerprintPreparedText(preparedText, { ...request, targetSchema: CAMP_TARGET_SCHEMA.slice(1) })).not.toBe(base);
  });

  it("changes when a hint changes", () => {
    expect(fingerprintPreparedText(preparedText, { ...request, fieldHints: { ...CAMP_FIELD_HINTS, "site-hint-0": "Session Full means FULL" } })).not.toBe(base);
  });

  it("changes when the model or runtime profile changes", () => {
    expect(fingerprintPreparedText(preparedText, { ...request, provider: "relay-extraction-provider:anthropic-compatible:glm-5.2" })).not.toBe(base);
  });

  it("changes when the text changes, and not for the per-request email token", () => {
    expect(fingerprintPreparedText(preparedText.replace("$3,850", "$3,950"), request)).not.toBe(base);
    const refetched = prepareAndChunk(listingHtml({ cfEmail: "35565458457551585b461b5a4752" }), "html").fullText;
    expect(refetched).not.toBe(preparedText);
    expect(fingerprintPreparedText(refetched, request)).toBe(base);
  });
});
