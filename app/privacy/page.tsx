import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How CampFit collects, uses, and protects your information. Draft under review.",
};

const LAST_UPDATED = "DRAFT — 2026-07-03";
const CONTACT_EMAIL = "hello@campfit.app";

type Block =
  | { kind: "p"; text: string }
  | { kind: "list"; items: string[] };

type Section = {
  id: string;
  heading: string;
  blocks: Block[];
};

const processors: { name: string; href: string; role: string; receives: string }[] = [
  {
    name: "Supabase",
    href: "https://supabase.com/privacy",
    role: "Authentication and database (our user store)",
    receives: "Email, name, password (managed by Supabase), and your saved data",
  },
  {
    name: "Google",
    href: "https://policies.google.com/privacy",
    role: "Sign in with Google (optional)",
    receives: "Handles Google sign-in and shares your email and name with us",
  },
  {
    name: "Stripe",
    href: "https://stripe.com/privacy",
    role: "Payment processing (Premium)",
    receives: "Your email, CampFit account ID, and card details you enter on Stripe",
  },
  {
    name: "Resend",
    href: "https://resend.com/legal/privacy-policy",
    role: "Email delivery",
    receives: "Your email address and the camp names in each message",
  },
  {
    name: "Vercel",
    href: "https://vercel.com/legal/privacy-policy",
    role: "Website hosting and cookieless Web Analytics",
    receives: "Standard request data (e.g., IP, browser) and aggregate analytics",
  },
];

const sections: Section[] = [
  {
    id: "who-we-are",
    heading: "1. Who we are",
    blocks: [
      {
        kind: "p",
        text:
          "CampFit (“CampFit,” “we,” “us,” or “our”) operates the website at https://camp.fit, a directory that helps parents in Denver, Colorado discover kids’ camps and save the ones they are interested in. This policy explains what personal information we collect, why we collect it, who we share it with, and the choices you have.",
      },
      {
        kind: "p",
        text:
          "If you only browse the camp directory without signing in, we do not require you to give us any personal information. Most of the data described below is collected only when you create an account and save camps.",
      },
    ],
  },
  {
    id: "info-we-collect",
    heading: "2. Information we collect",
    blocks: [
      {
        kind: "p",
        text:
          "Account and profile information. When you create an account we collect your email address (required to sign in and send the alerts you ask for) and a display name (the name you enter at sign-up, or the name Google returns if you sign in with Google).",
      },
      {
        kind: "p",
        text:
          "Authentication is handled by Supabase. You can sign in with an email and password, or with your Google account. If you use Google, Google shares your email and name with us to create your account. We do not request, receive, or store your Google profile photo, contacts, or any other Google data. Passwords are managed entirely by Supabase; we never see or store your password.",
      },
      {
        kind: "p",
        text:
          "Saved camps and notes. When you save a camp we store which camps you saved, the date, any private notes you attach, and your per-camp notification preferences.",
      },
      {
        kind: "p",
        text:
          "Notification preferences. Your account records whether you want email notifications. Toggles for push and SMS also exist, but push and SMS notifications are not active features today — only email is actually sent.",
      },
      {
        kind: "p",
        text:
          "Payment information. Premium payments are processed entirely by Stripe on Stripe-hosted pages. Your card number and payment details are entered on Stripe and never pass through or get stored on CampFit servers. We store only a Stripe customer and subscription identifier and your account tier (Free or Premium). We send Stripe your email and CampFit account ID so it can create your customer record.",
      },
      {
        kind: "p",
        text:
          "Communications. We send transactional and update emails through Resend — for example a “registration opens soon” alert for a saved camp, or a digest of newly added camps. Resend receives your email address and the names of the camps involved.",
      },
      {
        kind: "p",
        text:
          "Camp problem reports. If you report a problem on a camp listing, we store your email address and the description you submit so we can follow up and correct the listing.",
      },
      {
        kind: "p",
        text:
          "Technical information and cookies. When you sign in, Supabase sets secure session cookies so you stay logged in (strictly necessary). We store a small, non-tracking language-preference cookie. Your light/dark theme choice is stored in your browser, not sent to us. Our host, Vercel, processes standard request data (such as IP address and browser type) to serve and secure the site. We use Vercel Web Analytics and Vercel Speed Insights, privacy-focused, cookieless tools that measure aggregate page views and performance (Web Vitals); they do not use cross-site tracking cookies or build advertising profiles.",
      },
      {
        kind: "p",
        text:
          "Information we do NOT collect today. Our database schema contains optional fields for a phone number, a child age range, and preferred neighborhoods and categories. The current product has no way to enter or save any of these, and we do not collect them today. We do not use third-party advertising cookies, product-analytics trackers (other than the cookieless Vercel Web Analytics noted above), session-replay, or error-tracking that would receive your personal information, and we do not collect your precise geolocation.",
      },
    ],
  },
  {
    id: "how-we-use",
    heading: "3. How we use your information",
    blocks: [
      { kind: "p", text: "We use your information only to:" },
      {
        kind: "list",
        items: [
          "create and secure your account and keep you signed in;",
          "show and manage your saved camps and notes;",
          "send the camp alerts and digests you have opted into;",
          "process and manage your optional Premium subscription;",
          "respond to camp problem reports and support requests; and",
          "operate, maintain, secure, and improve the website.",
        ],
      },
      {
        kind: "p",
        text:
          "We do not sell your personal information, and we do not share it for cross-context behavioral advertising.",
      },
    ],
  },
  {
    id: "children",
    heading: "5. Children’s privacy (COPPA)",
    blocks: [
      {
        kind: "p",
        text:
          "CampFit is a service for parents and other adults, not for children. It is directed to adults researching camps for kids; we do not offer accounts to, or knowingly direct our service at, children under 13.",
      },
      {
        kind: "p",
        text:
          "CampFit is a discovery tool. We do not collect a child’s name, photo, date of birth, or contact information, and registration happens directly on each camp provider’s own website — not on CampFit. As noted above, our schema includes an optional child age-range preference, but the product does not collect it today.",
      },
      {
        kind: "p",
        text:
          "We do not knowingly collect personal information from children under 13. If you believe a child has provided us personal information, contact us and we will delete it.",
      },
    ],
  },
  {
    id: "retention",
    heading: "6. Data retention",
    blocks: [
      {
        kind: "p",
        text:
          "We keep your account and saved data for as long as your account is active. Camp problem reports are retained so we can maintain accurate listings. Stripe retains billing records under its own policies and applicable law. The product does not currently enforce an automated deletion schedule; if you ask us to delete your account, we will do so manually.",
      },
    ],
  },
  {
    id: "your-rights",
    heading: "7. Your choices and rights",
    blocks: [
      { kind: "p", text: "Today you can, on your own:" },
      {
        kind: "list",
        items: [
          "view and edit your saved camps and notes from your dashboard;",
          "remove individual saved camps;",
          "manage or cancel your Premium subscription through Stripe’s billing portal; and",
          "stop update/digest emails using the manage/unsubscribe link in those emails.",
        ],
      },
      {
        kind: "p",
        text:
          "Some rights are not yet self-service. There is currently no button to delete your entire account or to download all of your data. To exercise those rights today — including access, correction, deletion, or a copy of your data — email us at " +
          CONTACT_EMAIL +
          " and we will handle your request manually. We honor these requests regardless of where you live and will not discriminate against you for exercising a privacy right.",
      },
    ],
  },
  {
    id: "email",
    heading: "8. Email communications (CAN-SPAM)",
    blocks: [
      {
        kind: "p",
        text:
          "CampFit sends transactional/account emails (related to your account and the alerts you asked for) and update emails (such as a digest of newly added camps). You can turn off alerts in your notification settings or via the manage/unsubscribe link in the emails. We honor opt-out requests promptly, and our messages identify CampFit as the sender.",
      },
    ],
  },
  {
    id: "colorado",
    heading: "9. Colorado Privacy Act and other laws",
    blocks: [
      {
        kind: "p",
        text:
          "CampFit is built in Denver and primarily serves Colorado families. The Colorado Privacy Act grants residents rights to access, correct, delete, and obtain a portable copy of their data, and to opt out of targeted advertising, sale, and certain profiling.",
      },
      {
        kind: "p",
        text:
          "Based on our size and how little data we handle, we most likely fall below the Act’s applicability thresholds. Even so, we honor the core rights above for all users, we do not sell personal data, and we do not use it for targeted advertising. If you are in another state or country with similar rights, contact us and we will honor equivalent requests.",
      },
    ],
  },
  {
    id: "contact",
    heading: "10. How to contact us",
    blocks: [
      {
        kind: "p",
        text:
          "Questions, requests, or concerns about this policy or your data: email " +
          CONTACT_EMAIL +
          ".",
      },
    ],
  },
  {
    id: "changes",
    heading: "11. Changes to this policy",
    blocks: [
      {
        kind: "p",
        text:
          "We may update this policy as CampFit evolves — for example, if we activate a feature that collects new information. When we make material changes we will update the “Last updated” date above and, where appropriate, notify you. Because this is a draft, expect it to change before it becomes effective.",
      },
    ],
  },
];

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === "p" ? (
          <p
            key={i}
            className="text-bark-500 dark:text-cream-400 leading-relaxed mb-4"
          >
            {block.text}
          </p>
        ) : (
          <ul
            key={i}
            className="list-disc pl-6 mb-4 space-y-1.5 text-bark-500 dark:text-cream-400"
          >
            {block.items.map((item, j) => (
              <li key={j} className="leading-relaxed">
                {item}
              </li>
            ))}
          </ul>
        )
      )}
    </>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-12 sm:py-16">
      {/* Draft banner */}
      <div
        role="status"
        className="mb-10 rounded-2xl border border-terracotta-300/60 bg-terracotta-50 dark:bg-terracotta-500/10 px-5 py-4"
      >
        <p className="font-display font-bold text-terracotta-600 dark:text-terracotta-300 mb-1">
          Draft — under review
        </p>
        <p className="text-sm text-bark-500 dark:text-cream-400 leading-relaxed">
          {
            "This privacy policy is a working draft prepared from a review of the CampFit codebase. It is being reviewed by the owner and legal counsel, is not yet in effect, and is not legal advice."
          }
        </p>
      </div>

      <h1 className="font-display text-4xl sm:text-5xl font-extrabold text-bark-700 dark:text-cream-200 tracking-tight mb-3">
        Privacy Policy
      </h1>
      <p className="text-sm text-bark-300 dark:text-cream-500 mb-2">
        {"Effective date: to be set upon publication"}
      </p>
      <p className="text-sm text-bark-300 dark:text-cream-500 mb-10">
        {"Last updated: "}
        {LAST_UPDATED}
      </p>

      {/* Section 1 & 2 & 3 */}
      {sections.slice(0, 3).map((section) => (
        <section key={section.id} id={section.id} className="mb-10">
          <h2 className="font-display text-2xl font-bold text-bark-700 dark:text-cream-200 mb-4">
            {section.heading}
          </h2>
          <Blocks blocks={section.blocks} />
        </section>
      ))}

      {/* Section 4: processors table */}
      <section id="processors" className="mb-10">
        <h2 className="font-display text-2xl font-bold text-bark-700 dark:text-cream-200 mb-4">
          {"4. Service providers we share data with"}
        </h2>
        <p className="text-bark-500 dark:text-cream-400 leading-relaxed mb-4">
          {
            "We share personal information only with the vendors that make CampFit work, and only for the purposes above. Each is bound by its own privacy commitments."
          }
        </p>
        <div className="overflow-x-auto rounded-2xl border border-cream-400/50 dark:border-bark-600/50">
          <table className="w-full text-sm text-left">
            <thead className="bg-cream-200/70 dark:bg-bark-700/40 text-bark-600 dark:text-cream-300">
              <tr>
                <th className="px-4 py-3 font-semibold">Provider</th>
                <th className="px-4 py-3 font-semibold">What it does</th>
                <th className="px-4 py-3 font-semibold">What it receives</th>
              </tr>
            </thead>
            <tbody className="text-bark-500 dark:text-cream-400">
              {processors.map((p) => (
                <tr
                  key={p.name}
                  className="border-t border-cream-400/40 dark:border-bark-600/40 align-top"
                >
                  <td className="px-4 py-3">
                    <a
                      href={p.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-pine-600 dark:text-pine-300 font-medium underline underline-offset-2"
                    >
                      {p.name}
                    </a>
                  </td>
                  <td className="px-4 py-3">{p.role}</td>
                  <td className="px-4 py-3">{p.receives}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-bark-500 dark:text-cream-400 leading-relaxed mt-4">
          {
            "We also use AI providers (Anthropic, Google Gemini, and Z.AI) only to help gather and organize public information about camps for the directory. These providers are not given your account or personal information."
          }
        </p>
      </section>

      {/* Remaining sections 5-11 */}
      {sections.slice(3).map((section) => (
        <section key={section.id} id={section.id} className="mb-10">
          <h2 className="font-display text-2xl font-bold text-bark-700 dark:text-cream-200 mb-4">
            {section.heading}
          </h2>
          <Blocks blocks={section.blocks} />
        </section>
      ))}
    </div>
  );
}
