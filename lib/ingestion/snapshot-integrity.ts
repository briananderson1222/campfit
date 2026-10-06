/**
 * snapshot-integrity.ts — does a stored snapshot's content still hash to its
 * `bodyHash`, on the basis that hash was taken over?
 *
 * Since Traverse 5, a text capture is hashed by its response bytes, not by the
 * UTF-8 of its decoded text (Traverse docs/decisions/text-snapshot-bytes.md).
 * A capture then carries `bytes` and `declaredCharset`, and `body` is the
 * decode of those bytes. Rehashing `body` as UTF-8 rejects every new capture of
 * a page that is not plain UTF-8 (a latin1 page, a byte-order mark, invalid
 * UTF-8). Traverse's `snapshotHashBasis` names which input the hash covers.
 *
 * This mirrors the read rule of Traverse's bundled stores, which Traverse does
 * not export:
 * - binary (`bodyBytes`): SHA-256 of `bodyBytes`; `body` is empty and the
 *   record carries no text fields;
 * - byte-hashed text (`bytes`): SHA-256 of `bytes`; `declaredCharset` is a
 *   string or null; `body` must be exactly the decode of the bytes, so the
 *   text a reader checks citations against is the text the hash covers;
 * - otherwise (records written before Traverse 5): SHA-256 of the UTF-8 of
 *   `body`, with no `declaredCharset`.
 *
 * Every check fails closed: anything unexpected is "not intact".
 */
import { createHash } from "node:crypto";
import { decodeTextBody } from "@kontourai/forage/fetch";
import { snapshotHashBasis, type Snapshot } from "@kontourai/traverse/fetch";

/** SHA-256 hex of the content `snapshot.bodyHash` is meant to cover. */
export function snapshotContentHash(snapshot: Snapshot): string {
  const hash = createHash("sha256");
  if (snapshotHashBasis(snapshot) === "bytes") {
    const bytes = snapshot.bodyBytes ?? snapshot.bytes;
    if (!(bytes instanceof Uint8Array)) throw new TypeError("snapshot byte field is not a Uint8Array");
    hash.update(bytes);
  } else {
    hash.update(snapshot.body, "utf8");
  }
  return hash.digest("hex");
}

/**
 * The text a byte-hashed text record reads as: the decode of its bytes with its
 * declared charset. `undefined` when the record is not byte-hashed text.
 */
export function decodedSnapshotText(snapshot: Snapshot): string | undefined {
  if (snapshot.bodyBytes !== undefined || snapshot.bytes === undefined) return undefined;
  return decodeTextBody(snapshot.bytes, snapshot.declaredCharset ?? null).text;
}

/** Why `snapshot` is not intact, or `null` when it is. */
export function snapshotIntegrityProblem(snapshot: Snapshot): string | null {
  try {
    if (typeof snapshot.bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.bodyHash)) {
      return "bodyHash is not a full lowercase SHA-256";
    }
    if (snapshot.bodyBytes !== undefined) {
      if (!(snapshot.bodyBytes instanceof Uint8Array)) return "bodyBytes is not a Uint8Array";
      if (snapshot.bytes !== undefined || snapshot.declaredCharset !== undefined || snapshot.body !== "") {
        return "a binary record also carries text";
      }
    } else if (snapshot.bytes !== undefined) {
      if (!(snapshot.bytes instanceof Uint8Array)) return "bytes is not a Uint8Array";
      if (snapshot.declaredCharset !== null && typeof snapshot.declaredCharset !== "string") {
        return "bytes without a declaredCharset that is a string or null";
      }
      if (snapshot.body !== decodedSnapshotText(snapshot)) return "body is not the decode of bytes";
    } else {
      if (snapshot.declaredCharset !== undefined) return "declaredCharset without bytes";
      if (typeof snapshot.body !== "string") return "body is not a string";
    }
    if (snapshotContentHash(snapshot) !== snapshot.bodyHash) return "content does not hash to bodyHash";
    return null;
  } catch {
    return "content could not be hashed";
  }
}

export function isSnapshotIntact(snapshot: Snapshot): boolean {
  return snapshotIntegrityProblem(snapshot) === null;
}
