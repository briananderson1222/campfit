# Context Map

## Contexts

- [Camp Discovery](./docs/contexts/camp-discovery/CONTEXT.md) - parent-facing camp directory, saved camps, calendars, and comparison.
- [Data Stewardship](./docs/contexts/data-stewardship/CONTEXT.md) - admin work for keeping camp and provider information current, reviewed, and actionable.
- [Trust & Review Provenance](./docs/contexts/trust-review-provenance/CONTEXT.md) - review decisions, provenance, evidence, and trust export language.

## Relationships

- **Data Stewardship -> Camp Discovery**: reviewed, verified, or explicitly gap-labeled camp and provider information becomes the public directory experience parents use.
- **Data Stewardship -> Trust & Review Provenance**: crawls, proposals, attestations, and review actions produce provenance that explains why a value should be trusted.
- **Trust & Review Provenance -> Camp Discovery**: public-facing trust signals summarize the evidence and freshness behind camp information.
