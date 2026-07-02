# Trust & Review Provenance

Trust & Review Provenance is the language for explaining what CampFit claims, what evidence supports it, who reviewed it, and whether it is still reliable.

## Language

**Verification Status**:
The trust state of a claim, such as verified, assumed, stale, disputed, superseded, rejected, or revoked. Verification Status belongs to claims, not to admin workflow records.
_Avoid_: Attestation status, proposal status

**Verification Policy**:
The rule that says what Evidence is sufficient for a **Claim** to be **Verified**, including freshness expectations and required evidence types.
_Avoid_: Review state, confidence score

**Verification**:
The process of evaluating whether a **Claim** satisfies its **Verification Policy**.
_Avoid_: Review

**Freshness**:
Whether **Evidence** is recent enough to satisfy the **Verification Policy** for a **Claim**.
_Avoid_: Recency

**Verified**:
A **Verification Status** meaning a **Claim** is currently supported by sufficient evidence under the applicable policy.
_Avoid_: Reviewed

**Disputed**:
A **Verification Status** meaning a **Claim** is affected by an unresolved **Conflict**.
_Avoid_: Rejected

**Subject**:
The thing a **Claim** is about, such as a **Camp**, **Session**, or **Provider**.
_Avoid_: Trust bundle

**Attribute**:
A named property of a **Subject** that a **Claim** can describe, such as registration status, price, eligibility, or session dates.
_Avoid_: Field when speaking outside admin UI

**Claim**:
A statement about a **Camp**, **Provider**, or review artifact whose reliability can be evaluated from evidence and status. A **Proposal** is not itself a Claim, but it can produce candidate Claims.
_Avoid_: Fact, assertion

**Candidate Claim**:
A **Claim** proposed as a possible value during review. A Candidate Claim may become the accepted current Claim, be rejected, or remain inspectable as proposal history.
_Avoid_: Proposal

**Current Claim**:
The accepted **Claim** for a **Subject** Attribute right now. A Current Claim may be verified, stale, disputed, superseded, or revoked.
_Avoid_: Verified claim

**Conflict**:
Competing Evidence or Claims that cannot both be relied on as currently true. A Conflict may come from a Parent Correction, crawl result, review finding, or another source.
_Avoid_: Feedback, correction

**Evidence**:
Support used to evaluate a **Claim**. Evidence can come from public sources, human review, manual attestation, or system-generated review records.
_Avoid_: Proof, source

**Observation**:
A structured captured value from a **Raw Source**. An Observation may support a current Claim or a candidate Claim.
_Avoid_: Extraction, scrape result

**Raw Source**:
The original material an **Observation** came from, such as a public web page, manual admin entry, or system record.
_Avoid_: Evidence, citation

**Source of Authority**:
A **Raw Source** expected to be authoritative for a **Claim**, such as a Provider's own registration page for a Session's Registration Status.
_Avoid_: Source, citation

**Authority**:
The right or basis for an actor or source to support a **Claim** or **Review Decision**. A Provider page, Moderator, Admin, or Parent Correction may carry different authority depending on the Claim and policy.
_Avoid_: Permission when discussing evidence quality

**Review Decision**:
A specific human choice made during **Review**, such as accepting a Proposed Value or keeping the Current Value. A Review Decision can become evidence for a Claim.
_Avoid_: Click, approval

**Verified Camp**:
A **Camp** whose required Claims currently have **Verified** status.
_Avoid_: Reviewed camp

**Verified Camp Claim Set**:
The required claim groups for a **Verified Camp**: identity, location, description, classification, and contact or registration path. Sessions, prices, and registration availability belong to the **Verified Session Claim Set** unless the Camp has only one Session.
_Avoid_: Camp completeness

**Verified Session**:
A **Session** whose required Claims currently have **Verified** status.
_Avoid_: Reviewed session

**Verified Session Claim Set**:
The required claim groups for a **Verified Session**: session dates, session time or a clear reason time does not apply, eligibility, registration status, price options, and registration path. Unknown registration or price values require an explicit **Verification Gap**.
_Avoid_: Session completeness

**TrustBundle**:
A portable package of Claims, Evidence, policies, events, and provenance. A TrustBundle can be scoped to one **Camp**, one **Session**, a **Provider**, or a broader export, but it is not itself the Subject.
_Avoid_: Camp, session, record

**Trust Report**:
A derived view of a **TrustBundle** that shows current Claim statuses, Evidence, and Verification Gaps for inspection.
_Avoid_: Parent correction, analytics report

**Verification Gap**:
The reason a **Camp**, **Session**, or **Claim** is not currently Verified, such as missing evidence, stale evidence, disputed evidence, or unresolved review. CampFit should make Verification Gaps explicit when it does not call something Verified.
_Avoid_: Unverified

## Example Dialogue

**Parent**: Why is this Camp not marked Verified?

**Domain Expert**: A **Verified Camp** requires its required Claims to be Verified. This Camp has verified identity and location Claims, but the price Claim has no current Evidence, so CampFit should show that **Verification Gap** instead of calling the Camp Verified.

**Admin**: A reviewer accepted the new registration status from the provider page.

**Domain Expert**: That **Review Decision** can become Evidence for the registration-status **Claim**. If the Evidence satisfies the policy, the Claim's **Verification Status** can be **Verified**.

**Admin**: The page was crawled last year and has not changed in our database.

**Domain Expert**: The old **Observation** may still explain where the value came from, but the Claim may be stale if the Evidence no longer satisfies freshness expectations.
