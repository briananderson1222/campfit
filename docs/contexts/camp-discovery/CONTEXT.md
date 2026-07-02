# Camp Discovery

Camp Discovery is the parent-facing language for finding, comparing, saving, and planning around kids' camps.

## Language

**CampFit**:
The product parents use to find, compare, save, and plan around kids' camps. `camp.fit` is the web address, not the written product name.
_Avoid_: Campfit, CampScout

**Camp**:
A parent-selectable camp offering listed in CampFit. A **Camp** belongs to at most one **Provider**, and a **Provider** may run many Camps.
_Avoid_: Program, listing

**Provider**:
An organization that runs one or more **Camps**. Parents may care about a Provider's reputation, but they compare and save individual Camps.
_Avoid_: Organization, vendor

**Provider Presence**:
The local, Community-scoped Provider identity CampFit uses for Camps and Crawls. A broader chain or organization may have more than one Provider Presence across Communities.
_Avoid_: Provider brand

**Person**:
A human associated with a **Camp** or **Provider**, such as a director, instructor, owner, or contact. A Person may become parent-facing when CampFit has enough reliable data to show them.
_Avoid_: Staff record, contact record

**Role**:
The relationship between a **Person** and a **Camp** or **Provider**. A Role explains why that Person matters in this context, such as director, instructor, owner, or contact.
_Avoid_: Assignment, association

**Community**:
The local planning market parents browse in CampFit, such as the Denver metro area. A Community may include Camps in multiple **Cities** when parents reasonably consider them part of the same camp search.
_Avoid_: City, municipality

**City**:
The address locality for a **Camp** or **Provider**, such as Denver, Aurora, Evergreen, or Commerce City. City is a filterable location concept and may differ from the Camp's **Community**.
_Avoid_: Community

**Area**:
A parent-facing location label used for filtering and display within a **Community**. An Area may be a city, suburb, or neighborhood, such as Evergreen or Central Park.
_Avoid_: Neighborhood when the label may be a city or suburb

**Session**:
A dated occurrence of a **Camp**, with a start date and end date. A Camp may have many Sessions.
_Avoid_: Week

**Schedule**:
The collection of **Sessions** for a **Camp**.
_Avoid_: Availability

**Session Time**:
The daily time window for a **Session**, such as 9am-12pm or 9am-3pm. Overnight Sessions may not have a normal daily drop-off or pickup window.
_Avoid_: Hours

**Camp Format**:
How a **Camp** is attended, such as day camp, sleepaway, family, virtual, winter break, or school-break.
_Avoid_: Camp type

**Extended Care**:
Optional time around the **Session Time**, such as early drop-off or late pickup.
_Avoid_: Add-on hours

**Category**:
A broad parent-facing grouping for a **Camp**, such as Sports, Arts, STEM, or Nature. A Camp can have multiple Categories when it genuinely crosses broad parent search intents.
_Avoid_: Activity

**Activity**:
A more specific thing a child does at a **Camp**, such as soccer, robotics, ceramics, hiking, theater, or cooking. Activities are more detailed than **Categories** and may roll up into one or more Categories.
_Avoid_: Category

**Multi-Activity**:
A **Category** used when the Camp experience is intentionally broad rather than centered on one dominant Activity.
_Avoid_: Mixed, general

**Age Group**:
The eligibility range for a **Camp** or **Session**, expressed in ages, grades, or both.
_Avoid_: Grade group

**Published Age Group**:
The **Age Group** exactly as the **Provider** states it.
_Avoid_: Normalized age group

**Derived Eligibility Match**:
CampFit's inferred compatibility when a parent searches in a different form than the **Provider** published, such as age-to-grade or grade-to-age. Derived matches must remain explainable because age/grade conversion depends on birthdays, school cutoffs, and region.
_Avoid_: Published age group

**Price Option**:
One published way to pay for a **Camp** or **Session**.
_Avoid_: Price, fee

**Pricing Unit**:
How a **Price Option** is expressed, such as per week, per session, per day, flat, or per camp.
_Avoid_: Billing unit

**Comparable Price**:
CampFit's normalized price used for filtering, sorting, or comparison. A Comparable Price must be explainable and must not replace the published Price Option.
_Avoid_: Price option

**Registration Status**:
The current availability state for registering for a **Session**. When shown for a **Camp**, Registration Status is a summary and must not imply every Session has the same status.
_Avoid_: Availability

**Camp Registration Summary**:
A derived parent-facing summary of registration availability across a **Camp's** Sessions.
_Avoid_: Session registration status

**Open**:
A **Registration Status** meaning registration is accepting signups.
_Avoid_: Available

**Waitlist**:
A **Registration Status** meaning registration is full or constrained but is accepting waitlist entries.
_Avoid_: Open

**Full**:
A **Registration Status** meaning the **Camp** or **Session** is at capacity and is not clearly accepting waitlist entries.
_Avoid_: Waitlist

**Coming Soon**:
A **Registration Status** meaning registration is expected but not open yet.
_Avoid_: Closed

**Closed**:
A **Registration Status** meaning registration is not available.
_Avoid_: Full

**Unknown**:
A **Registration Status** meaning CampFit does not currently know whether registration is available.
_Avoid_: Closed

**Saved Camp**:
A **Camp** a parent keeps for later planning.
_Avoid_: Favorite

**Comparison**:
A parent-facing side-by-side view of multiple **Camps**.
_Avoid_: Compare list

**Calendar Export**:
A calendar file generated from saved **Camps** or a Camp's **Sessions**.
_Avoid_: Calendar sync

**Parent**:
A person using CampFit to plan camps for a child.
_Avoid_: Customer, visitor

**User**:
An authenticated CampFit account. A User may be a **Parent**, admin, moderator, or another account type.
_Avoid_: Parent when the account may have admin responsibilities

**Subscription Tier**:
The access level for a **User**, such as free or premium.
_Avoid_: Plan

**Parent Correction**:
Parent-submitted feedback that CampFit information may be wrong, missing, or out of date. A Parent Correction may surface a **Conflict** or lead to Review, but it does not change accepted data by itself.
_Avoid_: Report, review

**Parent Review**:
Parent-submitted experience feedback about a **Camp** or **Provider**, such as quality, fit, safety, communication, or satisfaction. A Parent Review is user-generated content, not evidence that Camp information is correct.
_Avoid_: Correction, report

**Source**:
Where CampFit got a piece of camp information, usually a Provider page. A Source helps parents understand why CampFit shows a value, but it is not the same as **Verification**.
_Avoid_: Crawl, scrape

## Example Dialogue

**Parent**: I need Denver sports camps for my fourth grader in July.

**Domain Expert**: Use the Denver **Community** because that is the planning market, then filter by **Category** Sports and July **Sessions**. If a Camp is in Aurora or Evergreen, its **City** may differ from the Community, and its **Area** may be the city, suburb, or neighborhood parents recognize.

**Parent**: The provider says grades 3-5, but I searched by age.

**Domain Expert**: The Provider published a **Published Age Group** in grades. CampFit can show a **Derived Eligibility Match** for your child's age, but that match should be explainable because age-to-grade conversion depends on birthdays, school cutoffs, and region.

**Parent**: Is registration open?

**Domain Expert**: Check the **Registration Status** for the Session. If the Camp has multiple Sessions, the **Camp Registration Summary** is only a rollup and does not mean every Session has the same status.
