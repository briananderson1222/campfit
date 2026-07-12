import nextVitals from "eslint-config-next/core-web-vitals";

const literalGlob = (path) => path.replaceAll("[", "[[]");

const config = [
  ...nextVitals,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    rules: {
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
    },
  },
  {
    files: ["app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='query']",
          message: "Database queries belong in the lib repository/data-access layer, not app routes or pages.",
        },
        {
          selector: "CallExpression[callee.name='getPool']",
          message: "Database pool access belongs in the lib repository/data-access layer, not app routes or pages.",
        },
        {
          selector: "NewExpression[callee.name='Pool']",
          message: "Database pool construction belongs in the lib repository/data-access layer, not app routes or pages.",
        },
      ],
    },
  },
  {
    // BURN-DOWN LIST: migrate these into lib repositories and remove entries as you go; never ADD to this list.
    files: [
      "app/admin/camps/[campId]/page.tsx",
      "app/admin/camps/page.tsx",
      "app/admin/people/[personId]/page.tsx",
      "app/admin/people/page.tsx",
      "app/admin/providers/[providerId]/page.tsx",
      "app/admin/trust/page.tsx",
      "app/admin/users/page.tsx",
      "app/api/admin/aggregators/[id]/candidates/onboard/route.ts",
      "app/api/admin/aggregators/[id]/candidates/route.ts",
      "app/api/admin/aggregators/[id]/discover/route.ts",
      "app/api/admin/aggregators/[id]/route.ts",
      "app/api/admin/aggregators/[id]/tos-decision/route.ts",
      "app/api/admin/aggregators/route.ts",
      "app/api/admin/assistant/route.ts",
      "app/api/admin/camps/[campId]/age-groups/route.ts",
      "app/api/admin/camps/[campId]/attest/route.ts",
      "app/api/admin/camps/[campId]/crawl/route.ts",
      "app/api/admin/camps/[campId]/route.ts",
      "app/api/admin/crawl-schedule/route.ts",
      "app/api/admin/crawl/onboard-url/route.ts",
      "app/api/admin/people/[personId]/route.ts",
      "app/api/admin/providers/[providerId]/crawl/route.ts",
      "app/api/admin/review/batch-accept/route.ts",
      "app/api/cron/notify/route.ts",
      "app/api/saves/route.ts",
      "app/api/stripe/checkout/route.ts",
      "app/api/stripe/portal/route.ts",
      "app/api/stripe/webhook/route.ts",
      "app/dashboard/page.tsx",
    ].map(literalGlob),
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];

export default config;
