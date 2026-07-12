import type { Pool, PoolClient } from "pg";
import { filterNewDiscoveries } from "./llm-discovery";
import type { DiscoveryPlaceholderInsert, DiscoveryPlaceholderRepository } from "./lookout-discovery";
import { slugify } from "./slug";

export interface DiscoveryAssociation {
  providerId: string | null;
  communitySlug: string;
  city: string | null;
}

/**
 * D1 repository for Lookout new-entity delivery. The transaction-level
 * advisory lock makes the canonical-name reread and insert one serializable
 * unit across concurrent crawl workers; the stable slug is a second durable
 * idempotency key for redelivery.
 */
export function createDiscoveryPlaceholderRepository(
  pool: Pool,
  association: DiscoveryAssociation,
): DiscoveryPlaceholderRepository {
  return {
    async insertIfNew(input: DiscoveryPlaceholderInsert): Promise<boolean> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["campfit:lookout-discovery"]);
        const names = await client.query<{ name: string }>(`SELECT name FROM "Camp"`);
        if (filterNewDiscoveries([input.stub], names.rows.map((row) => row.name)).length === 0) {
          await client.query("COMMIT");
          return false;
        }
        const inserted = await insertPlaceholder(client, input, association);
        await client.query("COMMIT");
        return inserted;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async recordObservationAndInsert(inputs, commitObservation) {
      const client = await pool.connect();
      let databaseCommitted = false;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["campfit:lookout-discovery"]);
        const names = await client.query<{ name: string }>(`SELECT name FROM "Camp"`);
        const canonicalNames = names.rows.map((row) => row.name);
        let inserted = 0;
        let ignored = 0;
        for (const input of inputs) {
          if (filterNewDiscoveries([input.stub], canonicalNames).length === 0) { ignored++; continue; }
          if (await insertPlaceholder(client, input, association)) {
            inserted++;
            canonicalNames.push(input.stub.name);
          } else ignored++;
        }
        await client.query("COMMIT");
        databaseCommitted = true;
        // DB first is intentional: inserts are idempotent, so an observation
        // failure is recovered by redelivery (DB no-op, observation catches
        // up). Advancing the append-only observation before COMMIT cannot be
        // compensated safely when the database commit fails.
        await commitObservation();
        return { inserted, ignored };
      } catch (error) {
        if (!databaseCommitted) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function insertPlaceholder(
  client: PoolClient,
  input: DiscoveryPlaceholderInsert,
  association: DiscoveryAssociation,
): Promise<boolean> {
  const sourceUrl = input.stub.detailUrl ?? input.stub.sourceUrl;
  const slug = slugify(input.stub.name) || "discovered-camp";
  const result = await client.query(
    `INSERT INTO "Camp" (
       name, slug, "websiteUrl", "communitySlug", city, "dataConfidence",
       "campType", category, "campTypes", categories, "providerId", "fieldSources"
     ) VALUES (
       $1, $2, $3, $4, $5, 'PLACEHOLDER', 'SUMMER_DAY', 'OTHER',
       ARRAY['SUMMER_DAY'], ARRAY['OTHER'], $6, $7::jsonb
     )
     ON CONFLICT (slug) DO NOTHING
     RETURNING id`,
    [input.stub.name, slug, sourceUrl, association.communitySlug, association.city, association.providerId, JSON.stringify(input.fieldSources)],
  );
  return result.rowCount === 1;
}
