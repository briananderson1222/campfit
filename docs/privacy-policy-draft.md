# CampFit Privacy Policy — DRAFT

> **DRAFT — under review.** This document was drafted by an AI agent from a
> direct inventory of the CampFit codebase on **2026-07-03** (owner-authorized).
> It is a best-effort starting point for the owner and legal counsel to review
> and edit. **It is not legal advice** and has not been reviewed by an attorney.
> Every substantive claim is mapped to a source file in the
> [Evidence Appendix](#evidence-appendix) at the end of this document.

**Effective date:** _[TO BE SET UPON PUBLICATION]_
**Last updated:** _DRAFT — 2026-07-03_

---

## 1. Who we are

CampFit ("CampFit," "we," "us," or "our") operates the website at
**https://camp.fit**, a directory that helps parents in Denver, Colorado
discover kids' camps and save the ones they're interested in. This policy
explains what personal information we collect when you use CampFit, why we
collect it, who we share it with, and the choices you have.

If you only browse the camp directory without signing in, we do not require you
to give us any personal information. Most of the data described below is
collected only when you create an account and save camps.

## 2. Information we collect

### 2.1 Account and profile information
When you create an account, we collect:

- **Email address** — required to sign in and to send you the alerts you ask
  for.
- **Display name** — the name you enter at sign-up, or the name returned by
  Google if you sign in with Google.

Authentication is handled by **Supabase** (our authentication and database
provider). You can sign in two ways: with an email address and password, or
with your Google account ("Sign in with Google"). If you use Google, Google
shares your email address and name with us so we can create your account. We do
**not** request, receive, or store your Google profile photo, contacts, or any
other Google data.

Passwords are managed entirely by Supabase's authentication system. We never see
or store your password.

### 2.2 Saved camps and notes
When you save a camp, we store which camps you saved, the date you saved them,
any private notes you attach, and your per-camp notification preferences. This
lets us show you your saved list and alert you about those camps.

### 2.3 Notification preferences
Your account stores whether you want to receive email notifications. Toggles for
push and SMS notifications also exist in your account, but **push and SMS
notifications are not active features today** — only email notifications are
actually sent (see Section 3).

### 2.4 Payment information
CampFit offers an optional paid ("Premium") subscription. Payments are processed
entirely by **Stripe** on Stripe-hosted checkout and billing pages. **Your card
number and payment details are entered on Stripe's pages and never pass through
or get stored on CampFit's servers.** What we store is limited to:

- a Stripe customer identifier and subscription identifier (so we know which
  Stripe customer you are and whether your subscription is active), and
- your account tier (Free or Premium).

We send Stripe your email address and your CampFit account ID so Stripe can
create your customer record.

### 2.5 Communications you receive
We send transactional and update emails through **Resend**, our email delivery
provider — for example, a "registration opens soon" alert for a camp you saved,
or a periodic digest of newly added camps. To send these, Resend receives your
email address and the names of the camps involved.

### 2.6 Camp problem reports
If you use the "report a problem" feature on a camp, we store your email address
and the free-text description you submit, so we can follow up and correct the
listing.

### 2.7 Technical information and cookies
- **Authentication cookies.** When you sign in, Supabase sets secure session
  cookies in your browser so you stay logged in. These are strictly necessary
  for the site to work.
- **Language cookie.** We store a small, non-tracking cookie recording your
  language preference (English or Spanish).
- **Theme preference.** Your light/dark theme choice is stored in your browser's
  local storage, not sent to us.
- **Hosting logs.** CampFit is hosted on **Vercel**. Like most web hosts, Vercel
  processes standard request data (such as IP address and browser type) to serve
  and secure the site.
- **Analytics.** We use **Vercel Web Analytics**, a privacy-focused analytics
  tool that measures aggregate page views and performance. Vercel Web Analytics
  is designed to be **cookieless** and does not use cross-site tracking cookies
  or build advertising profiles of visitors.

### 2.8 Information we do NOT collect today
To be transparent: our database schema contains optional fields for a phone
number, a child's age range (a minimum and maximum age), and preferred
neighborhoods and activity categories. **The current product has no way to enter
or save any of these — there is no screen or feature that collects them, and we
do not collect them today.** If that changes, we will update this policy before
turning any such collection on.

We do **not** use third-party advertising cookies, product-analytics trackers
(such as Google Analytics, and other than the cookieless Vercel Web Analytics
noted above), session-replay tools, or error-tracking services that would
receive your personal information. We do not collect your precise geolocation.

## 3. How we use your information

We use the information above only to:

- create and secure your account and keep you signed in;
- show and manage your saved camps and notes;
- send the camp alerts and digests you've opted into;
- process and manage your optional Premium subscription;
- respond to camp problem reports and support requests; and
- operate, maintain, secure, and improve the CampFit website.

We do **not** sell your personal information, and we do not share it for
cross-context behavioral advertising.

## 4. Service providers (processors) we share data with

We share personal information only with the vendors that make CampFit work, and
only for the purposes above. Each is bound by its own privacy commitments:

| Provider | What it does for us | What it receives |
| --- | --- | --- |
| [Supabase](https://supabase.com/privacy) | Authentication and database (our user store) | Email, name, password (managed by Supabase), your saved data |
| [Google](https://policies.google.com/privacy) | "Sign in with Google" (optional) | Handles Google sign-in; shares your email and name with us |
| [Stripe](https://stripe.com/privacy) | Payment processing (Premium) | Your email, CampFit account ID, and card details you enter on Stripe |
| [Resend](https://resend.com/legal/privacy-policy) | Email delivery | Your email address and the camp names in each message |
| [Vercel](https://vercel.com/legal/privacy-policy) | Website hosting and cookieless Web Analytics | Standard request data (e.g., IP, browser) and aggregate analytics |

We also use AI providers (Anthropic, Google Gemini, and Z.AI) **only** to help
gather and organize public information about camps for the directory. These
providers are **not** given your account or personal information.

## 5. Children's privacy (COPPA)

**CampFit is a service for parents and other adults**, not for children.
It is directed to adults who are researching camps for kids; we do not offer
accounts to, or knowingly direct our service at, children under 13.

CampFit is a camp **discovery** tool. We do not collect a child's name, photo,
date of birth, or contact information, and we are not the place where you
register a child for a camp — registration happens directly on each camp
provider's own website. As noted in Section 2.8, our schema includes an optional
"child age range" preference field, but the product does not collect it today.

We do not knowingly collect personal information from children under 13. If you
believe a child has provided us personal information, please contact us (Section
10) and we will delete it.

## 6. Data retention

We keep your account information and saved data for as long as your account is
active. Camp problem reports are retained so we can maintain accurate listings.
Stripe retains billing records according to its own policies and applicable law.

**Honest note for review:** the product does not currently have an automated
data-retention or deletion schedule in code. If you ask us to delete your
account (Section 7), we will do so manually. The owner and legal counsel should
decide on a formal retention period before publication.

## 7. Your choices and rights

Today you can, on your own:

- **View and edit** your saved camps and notes at any time from your dashboard;
- **Remove** individual saved camps;
- **Manage or cancel** your Premium subscription through Stripe's billing portal;
  and
- **Stop marketing/digest emails** using the unsubscribe/manage link in those
  emails (see Section 8).

Some rights are **not yet self-service** in the product. There is currently no
button to delete your entire account or to download all of your data. To
exercise those rights today — including access, correction, deletion, or a copy
of your data — please email us at **hello@campfit.app** and we will handle your
request manually.

We honor these requests regardless of where you live, and we will not
discriminate against you for exercising any privacy right.

## 8. Email communications (CAN-SPAM)

CampFit sends two kinds of email:

- **Transactional/account emails** related to your account and the alerts you
  explicitly asked for (for example, a saved camp's registration opening).
- **Update emails**, such as a digest of newly added camps.

You can turn off the alerts by adjusting your notification settings or by using
the manage/unsubscribe link included in the emails. We will honor opt-out
requests promptly. Our messages identify CampFit as the sender.

## 9. Colorado Privacy Act and other privacy laws

CampFit is built in Denver and primarily serves Colorado families. The Colorado
Privacy Act (CPA) grants Colorado residents rights to access, correct, delete,
and obtain a portable copy of their personal data, and to opt out of targeted
advertising, sale, and certain profiling.

Based on our size and how little data we handle, we most likely fall **below**
the CPA's applicability thresholds. Even so, **we honor the core CPA rights for
all users** as described in Section 7, and we do not sell personal data or use it
for targeted advertising. If you are in another U.S. state (or elsewhere) with
similar privacy rights, contact us and we will honor equivalent requests.

## 10. How to contact us

Questions, requests, or concerns about this policy or your data:

**Email:** hello@campfit.app

_(Contact address to be confirmed by the owner before publication — see the
appendix note about the camp.fit / campfit.app domain difference.)_

## 11. Changes to this policy

We may update this policy as CampFit evolves — for example, if we activate a
feature that collects new information. When we make material changes, we will
update the "Last updated" date above and, where appropriate, notify you. Because
this is a **draft**, expect it to change before it becomes effective.

---

## Evidence Appendix

This appendix is the review artifact. It maps each substantive claim in the
policy to the code or schema that supports it, so the owner and counsel can
verify the policy describes what CampFit actually does. Paths are relative to the
repository root. "Verified" = confirmed present in the codebase as described on
2026-07-03.

| # | Policy claim | Source (file:location) | Verified |
| --- | --- | --- | --- |
| 1 | Site is hosted at https://camp.fit; directory of Denver kids' camps | `app/layout.tsx` (BASE_URL, metadata); `components/footer.tsx` (Denver copy) | Yes |
| 2 | Browsing without an account requires no personal info | No auth gate on public routes; only `/admin` gated in `proxy.ts` | Yes |
| 3 | We collect email + display name on account creation | `app/api/saves/route.ts:44` (`INSERT INTO "User" (id, email, name)`); `app/auth/signup/page.tsx` | Yes |
| 4 | Auth handled by Supabase; email/password + Google OAuth | `lib/supabase/server.ts`, `lib/supabase/client.ts`; `app/auth/login/page.tsx` (`signInWithOAuth({provider:"google"})`, `signInWithPassword`); `app/auth/callback/route.ts` | Yes |
| 5 | Google shares only email + name; no photo/other Google data stored | `app/api/saves/route.ts:48` uses `user.email` + `user.user_metadata?.name` only; no avatar/photo read anywhere | Yes |
| 6 | We never see or store passwords (Supabase manages them) | No password column in `prisma/schema.prisma` `User`; auth via `@supabase/ssr` | Yes |
| 7 | We store saved camps, dates, notes, per-camp notify prefs | `prisma/schema.prisma` model `SavedCamp` (notes, notifyEmail/Push/Sms, savedAt); `app/api/saves/route.ts` | Yes |
| 8 | Account notification preferences exist (email active) | `prisma/schema.prisma` `User.notifyEmail/notifyPush/notifySms` | Yes |
| 9 | Push and SMS notifications are NOT active features today | No `web-push` dependency in `package-lock.json`; no code reads/writes `PushSubscription`; no SMS provider; `notifyPush/Sms` are display-only in `components/dashboard-client.tsx` | Yes |
| 10 | Payments processed by Stripe on Stripe-hosted pages | `app/api/stripe/checkout/route.ts` (`stripe.checkout.sessions.create` → redirect `session.url`); `app/api/stripe/portal/route.ts` (billing portal) | Yes |
| 11 | Card details never touch CampFit servers | No card fields received anywhere in `app/api/stripe/*`; only hosted Checkout/Portal used | Yes |
| 12 | We store Stripe customer/subscription IDs + tier only | `prisma/schema.prisma` `User.stripeCustomerId/stripeSubscriptionId/tier`; `app/api/stripe/webhook/route.ts` writes them | Yes |
| 13 | We send Stripe the user's email + CampFit account ID | `app/api/stripe/checkout/route.ts` (`stripe.customers.create({email, metadata:{userId}})`) | Yes |
| 14 | Emails delivered via Resend; alerts + digests | `lib/notifications/email.ts` (`new Resend(...)`, `sendRegistrationAlert`, `sendNewCampDigest`); `app/api/cron/notify/route.ts` | Yes |
| 15 | Resend receives user email + camp names only | `lib/notifications/email.ts` (`to`, `campName` params); cron query selects `u.email` | Yes |
| 16 | Camp problem reports store user email + description | `prisma/schema.prisma` model `CampReport` (`userEmail`, `description`); `app/api/camps/[slug]/report/route.ts` | Yes |
| 17 | Supabase sets secure session cookies to keep you signed in | `lib/supabase/server.ts` (cookie get/set); `proxy.ts` (`response.cookies.set`, `getUser()`) | Yes |
| 18 | Non-tracking language cookie ("lang") | `lib/i18n/lang-context.tsx` (`COOKIE_NAME = "lang"`, SameSite=Lax) | Yes |
| 19 | Theme preference stored in browser local storage, not sent to us | `app/layout.tsx` (`next-themes` ThemeProvider); next-themes uses localStorage | Yes |
| 20 | Hosted on Vercel; Vercel Cron for notifications | `vercel.json` (crons → `/api/cron/notify`); deployment domain camp.fit | Yes |
| 21 | We use Vercel Web Analytics (cookieless) | `@vercel/analytics` + `<Analytics/>` in `app/layout.tsx` | **PENDING — NOT on main.** PR #1 (`vercel/install-vercel-web-analytics-f-ynlia0`, commit `4d902e4`) is still OPEN/unmerged as of 2026-07-03. See "Surprising findings." |
| 22 | Phone, child age range, preferred neighborhoods/categories NOT collected today | `prisma/schema.prisma` `User` defines `phoneNumber/childAgeMin/childAgeMax/preferredNeighborhoods/preferredCategories`, but grep found NO read/write path in `app/` or `lib/` | Yes |
| 23 | No third-party ad cookies / product analytics / session replay / error tracking | No Sentry, PostHog, GA/gtag, Mixpanel, or FullStory in `package.json`/`package-lock.json` | Yes |
| 24 | We don't collect precise user geolocation | Only camp `latitude/longitude` (facility locations) in `prisma/schema.prisma`; no user geolocation captured | Yes |
| 25 | AI providers process camp data, not user PII | `ANTHROPIC_API_KEY/ZAI_API_KEY/GEMINI_API_KEY` used only in `lib/ingestion/` and `app/api/admin/` | Yes |
| 26 | We do not sell personal information | No data-sharing/sale code path exists | Yes (absence) |
| 27 | Users can view/edit/remove saved camps themselves | `app/api/saves/route.ts` (GET/POST/DELETE); `components/dashboard-client.tsx` | Yes |
| 28 | Users can manage/cancel subscription via Stripe portal | `app/api/stripe/portal/route.ts` | Yes |
| 29 | No self-serve account deletion or full data export today | No account-delete or data-export endpoint/UI anywhere in `app/`; no `/settings` route | Yes |
| 30 | Account deletion/data requests handled manually via email | Follows from #29 (no code path); manual process | Yes (by absence) |
| 31 | Children's data: service directed at parents/adults; no child accounts | No child-facing features; accounts are for adult users; registration is off-site on provider websites | Yes |
| 32 | Contact email hello@campfit.app | `lib/ingestion/traverse-snapshot-store.ts:36` (only email literal in codebase; domain is campfit.app, not camp.fit) | Yes (with domain caveat) |
| 33 | Colorado focus; likely below CPA thresholds; rights honored anyway | `components/footer.tsx` ("Built in Denver, CO"); thresholds are a legal/business judgment, not code | Partial — code supports Colorado focus; threshold status is a legal determination for counsel |

### Notes and caveats for the reviewer
- **Claim #21 (Vercel Web Analytics) is the one claim not yet true on `main`.** The
  policy discloses it per the owner/orchestrator's direction and because the PR
  is expected to ship, but as of 2026-07-03 PR #1 is still open. If PR #1 is not
  merged, either merge it or remove the analytics disclosure before publishing.
- **Contact-domain mismatch:** the website is `camp.fit` but the only email
  address in the codebase uses `campfit.app`. The owner should confirm the
  canonical support address before publication.
- **`authProvider` is never populated:** the `User.authProvider` enum defaults to
  `EMAIL` and is not set even for Google sign-ups. The policy therefore does not
  claim we record your sign-in method in our database.
- **Retention:** there is no automated retention/deletion job in code (see
  Section 6). This is a policy decision to finalize with counsel.
- **Possible bug (not policy-blocking):** `app/api/calendar/export/route.ts`
  queries table/column names (`UserSave`, `authId`) that don't match the current
  `SavedCamp`/`userId` schema. Flagged for the team; it is the saved-camp `.ics`
  export surface.
