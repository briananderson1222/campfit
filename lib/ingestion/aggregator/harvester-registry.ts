/**
 * Shared registry of aggregator harvesters, so both the stub-seeding CLI
 * (scripts/harvest-aggregator.ts) and the provider source-crawl CLI
 * (scripts/crawl-aggregator-providers.ts) resolve `--source <key>` the same
 * way. Add a harvester here once and both entry points pick it up.
 */
import { ActivitiesKidsHarvester } from './activitieskids';
import { CamperoniHarvester } from './camperoni';
import type { BaseHarvester } from './base-harvester';

export const HARVESTERS: Record<string, () => BaseHarvester> = {
  activitieskids: () => new ActivitiesKidsHarvester(),
  camperoni: () => new CamperoniHarvester(),
};

/** Resolve a source key to a fresh harvester instance, or null if unknown. */
export function getHarvester(source: string): BaseHarvester | null {
  const factory = HARVESTERS[source];
  return factory ? factory() : null;
}

/** Comma-separated list of known source keys, for usage/error messages. */
export function knownSources(): string {
  return Object.keys(HARVESTERS).join(', ');
}
