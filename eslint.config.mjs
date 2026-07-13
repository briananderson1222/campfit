import nextVitals from "eslint-config-next/core-web-vitals";

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
];

export default config;
