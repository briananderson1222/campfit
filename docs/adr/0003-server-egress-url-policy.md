> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# Server egress URLs require address-vetted, connection-pinned transports

**Date:** 2026-07-12

## Status

Accepted.

## Context

CampFit fetches operator-entered, stored, discovered, and browser-derived URLs. Syntax checks, authentication, robots rules, and a DNS lookup followed by an ordinary hostname fetch do not prevent SSRF. DNS may return mixed answers or change between validation and connection; redirects and browser subresources create fresh egress decisions.

## Decision

`lib/security/egress-url-policy.ts` is the only owner of server-egress URL parsing, host normalization, address classification, DNS resolution, and transport profiles. HTTP transports must use manual redirects, re-evaluate each hop, and connect to a vetted address while retaining the original HTTP Host and TLS SNI hostname. A hostname is denied when resolution is empty, indeterminate, or contains any denied address.

Production profiles are `operatorDiscovery`, `storedCrawlTarget`, `discoveredLink`, `browserSubresource`, and `fixedHarvester`. All currently share the baseline: HTTP or HTTPS only, no URL credentials, scheme-default ports only, no arbitrary caller exceptions, and at most five redirects. Profile-specific narrowing may be added, but weakening requires a new decision and threat fixtures.

The policy classifies parsed address bytes, not textual prefixes. It denies:

| Family | Denied ranges/classes |
| --- | --- |
| IPv4 | `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4` |
| IPv6 | unspecified and loopback, discard-only `100::/64`, special/reserved `2001::/23`, benchmark `2001:2::/48`, documentation `2001:db8::/32`, deprecated 6to4 `2002::/16`, `fc00::/7`, `fe80::/10`, deprecated site-local `fec0::/10`, and multicast `ff00::/8` |
| Mapped/metadata | IPv4-mapped IPv6 is unmapped and classified as IPv4; link-local metadata addresses and well-known metadata hostnames are denied |

Errors are typed and safe for logs or stable application mapping. They contain a reason code, profile, and normalized host only—never credentials, paths, queries, resolver internals, or connector failures.

## Browser limitation

Playwright request interception can reject disallowed requests but does not itself pin Chromium's connection to the address vetted by Node DNS. Chromium does not expose a per-request API that both selects an exact IP and preserves TLS hostname/SNI. Browser-based egress therefore must fail closed for hostnames until an architecture with demonstrable address pinning (for example a trusted, policy-enforcing outbound proxy) is installed. Pre-resolution alone must not be described as DNS-rebinding protection.

## Exceptions and rollout

There is no request-controlled allowlist or port override. A compatibility exception requires an owner-reviewed, named configuration profile, range/redirect/rebinding fixtures, a documented operational need and expiry/review condition, and a new or superseding decision. Test fixtures needing loopback use injected resolvers/connectors or a test-only profile; production policy is not broadened.

Every live E1–E9 transport must adopt the canonical adapter before aggregator activation. Stored-URL dry runs may report decisions without connecting. Replay and exact-snapshot extraction are non-network paths and remain outside the guard.

## Consequences

Some legacy URLs and non-default-port fixtures will be rejected until explicitly redesigned. HTTP connections can be safely pinned in-process while retaining Host/SNI. Browser egress remains a release stop until its pinning limitation is solved, not an accepted residual risk.
