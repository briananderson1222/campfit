# Data Stewardship

Data Stewardship is the admin-facing language for keeping CampFit camp and provider information current, reviewed, and ready for parent-facing use.

## Language

**Crawl**:
An admin workflow that discovers or refreshes camp and provider information from public web sources. A **Crawl** may produce proposed changes, but it does not by itself make those changes trusted.
_Avoid_: Scrape, scrape run

**Provider Presence**:
The local, Community-scoped Provider identity CampFit uses to scope Camps, Crawls, Proposals, and admin review. Provider Presence prevents one broader organization from pulling unrelated camps into the wrong Community.
_Avoid_: Provider brand

**Source Page**:
A public web page used as source material for camp or provider information. A Source Page may support Evidence, a **Proposal**, or an **Attestation**.
_Avoid_: Crawl result

**Crawl Hint**:
Admin guidance that helps future **Crawls** find or interpret camp or provider information for a source or domain. A Crawl Hint influences extraction but does not itself verify a **Claim**.
_Avoid_: Evidence, attestation

**Learning Signal**:
A review-derived signal that helps improve future **Crawls**, such as why a Proposed Value was rejected or why a Current Value was kept. A Learning Signal is not accepted camp data.
_Avoid_: Review decision, evidence

**Proposal**:
A suggested change to a **Camp** or **Provider** that requires human review before it becomes accepted data. A **Proposal** may contain one or more proposed Attribute changes.
_Avoid_: Change request, pending update

**Review**:
The human decision process for resolving a **Proposal** or inspecting a flagged stewardship concern. Review is required before a Proposed Value becomes accepted data.
_Avoid_: Approval flow, moderation

**Current Value**:
A value CampFit already has for an **Attribute** before reviewing a **Proposal**. Keeping the Current Value means the proposed change was not accepted for that Attribute.
_Avoid_: Old value, existing value

**Proposed Value**:
A value a **Proposal** suggests for an **Attribute**. A Proposed Value becomes accepted data only after review.
_Avoid_: New value, replacement value

**Review Apply**:
The transactional step where a resolved **Review** makes approved **Proposed Values** the accepted data for a **Camp**, records provenance for each applied Attribute, and re-evaluates verification. A Review Apply is all-or-nothing for the Attributes it applies; a partial Review Apply leaves the **Proposal** in queue for the remaining Attributes.
_Avoid_: Approve endpoint, merge

**Attestation**:
A human-backed statement that a **Current Value** was reviewed and considered acceptable at a point in time. An Attestation is one way CampFit creates evidence for a trust claim about an Attribute.
_Avoid_: Manual verification, admin approval

**Active Attestation**:
An **Attestation** that is currently usable as evidence for an Attribute claim. An Active Attestation can support a verified or assumed claim in trust language.
_Avoid_: Verified attestation

**Stale Attestation**:
An **Attestation** that may be too old to rely on without renewed review. A Stale Attestation supports a stale claim in trust language.
_Avoid_: Expired attestation

**Invalidated Attestation**:
An **Attestation** that was explicitly knocked out by newer information or correction. An Invalidated Attestation no longer supports the Attribute claim.
_Avoid_: Revoked attestation, rejected attestation

**Review Flag**:
A marker that a **Camp**, **Provider**, or **Person** needs steward attention. A Review Flag is not itself a Proposal and does not change accepted data.
_Avoid_: Proposal, task

**Parent Correction**:
Parent-submitted feedback that CampFit information may be wrong, missing, or out of date. A Parent Correction creates admin attention and may surface a **Conflict** or lead to **Review**, but does not change accepted data by itself.
_Avoid_: Report, review

**Admin**:
A **User** with platform-wide stewardship authority.
_Avoid_: Moderator

**Moderator**:
A **User** with stewardship authority limited to one or more **Communities**.
_Avoid_: Admin

**Community Assignment**:
The relationship that grants a **Moderator** stewardship authority in a **Community**.
_Avoid_: Role

**Review State**:
Whether a **Camp** or **Provider** needs admin attention before parents should rely on its information.
_Avoid_: Data confidence

**Unreviewed**:
A **Camp** or **Provider** exists in CampFit, but required information has not yet been checked or attested.
_Avoid_: Placeholder

**Reviewed**:
A **Camp** or **Provider** has review history. Reviewed does not guarantee current reliability, because required claims may later become stale, disputed, superseded, or missing.
_Avoid_: Verified

**Stale**:
Previously reviewed information needs renewed review.
_Avoid_: Expired

**Archived**:
A **Camp** or **Provider** intentionally removed from normal parent-facing discovery without deleting its history.
_Avoid_: Deleted

## Example Dialogue

**Admin**: I ran a Crawl for a Provider and it found a new registration date.

**Domain Expert**: The Crawl can create a **Proposal**, but the Proposed Value is not accepted data until **Review** resolves it.

**Admin**: The source page is vague, so I want to keep what CampFit already has.

**Domain Expert**: Keep the **Current Value** and record the reason in the Review. If the Attribute is acceptable but the source is not explicit, use an **Attestation** only when a human can stand behind the Current Value.

**Admin**: This Camp was reviewed last season, but some details may have changed.

**Domain Expert**: It is still **Reviewed** as history, but its **Review State** may now be **Stale** until the required claims are refreshed.

**Admin**: A parent says registration is full, but the Provider page still says open.

**Domain Expert**: Treat that **Parent Correction** as a possible **Conflict**. It creates admin attention, but the accepted value should change only after Review resolves the conflict.
