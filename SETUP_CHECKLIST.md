# CampScout Setup Checklist

## ✅ Done Automatically
- Supabase DB schema + 158 camps seeded
- Vercel deployment (https://camp-scout-pied.vercel.app)
- Auth (email signup/login working)
- Saves, dashboard, calendar all live

---

## 🔧 Things You Need To Do Manually

### 1. Google OAuth (optional but recommended)
1. Go to [console.cloud.google.com](https://console.cloud.google.com) → Create project → APIs & Services → Credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add authorized redirect URI: `https://rpnzolnnhbzhuspwpajq.supabase.co/auth/v1/callback`
4. Go to Supabase dashboard → Authentication → Providers → Google
5. Paste the Client ID and Client Secret → Save

### 2. Stripe (monetization)
1. Create account at [stripe.com](https://stripe.com)
2. Create a Product: "CampScout Premium" → Price: $8/month recurring
3. Copy the Price ID (starts with `price_...`)
4. Go to Stripe → Developers → Webhooks → Add endpoint:
   - URL: `https://camp-scout-pied.vercel.app/api/stripe/webhook`
   - Events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
   - Copy the Signing Secret (starts with `whsec_...`)
5. Add to Vercel → Settings → Environment Variables (Production):
   - `STRIPE_SECRET_KEY` = your secret key (starts with `sk_live_...`)
   - `STRIPE_PRICE_ID` = the price ID from step 2
   - `STRIPE_WEBHOOK_SECRET` = the signing secret from step 4

### 3. Resend (email notifications)
1. Create account at [resend.com](https://resend.com)
2. Add and verify your sending domain (or use Resend's free onboarding domain for testing)
3. Create an API key
4. Add to Vercel:
   - `RESEND_API_KEY` = your API key
   - `RESEND_FROM_EMAIL` = `CampScout <notifications@yourdomain.com>`

### 4. Cron security
- Add to Vercel: `CRON_SECRET` = any long random string (e.g. run `openssl rand -hex 32`)

### 5. After adding all Vercel env vars
- Redeploy once: `vercel --prod`

---

### 6. GitHub Actions (CI + deploy + scraper)
1. Go to your GitHub repo → Settings → Secrets and variables → Actions
2. Add CI/build secrets:
   - `ADMIN_EMAILS`
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `PGHOST`
   - `PGPORT`
   - `PGDATABASE`
   - `PGUSER`
   - `PGPASSWORD`
   - `CRON_SECRET`
3. Add optional service secrets if those features are enabled:
   - `ANTHROPIC_API_KEY`
   - `GEMINI_API_KEY`
   - `RESEND_API_KEY`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `VERCEL_REVALIDATE_URL`
4. Add Actions variables:
   - `NEXT_PUBLIC_APP_URL`
   - `RESEND_FROM_EMAIL`
   - `STRIPE_PRICE_ID`
   - `VERCEL_PROJECT_ID`
   - `VERCEL_ORG_ID`
5. Add deploy secret:
   - `VERCEL_TOKEN`
6. `CI` runs Prisma validation and `tsc` on every push/PR, then runs `next build` and `npm run verify:admin` when the required secrets are present
7. `Deploy` runs on pushes to `main` and deploys the production build to Vercel
8. The scraper runs every Monday at 6am UTC automatically
9. To test locally: `npm run scrape:dry` (no DB writes)
10. To add a new camp site scraper, create a new file in `lib/ingestion/scrapers/` following the Avid4 pattern, then register it in `scripts/scrape.ts`

---

## 📋 Future Work (in PLAN.md)
- Phase 4: Web scraper to auto-update camp data
- Phase 5: Map view, camp comparison, SEO, calendar export
- Web Push + SMS notifications (deferred)
- "New camps matching your preferences" digest
