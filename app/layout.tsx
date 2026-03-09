import type { Metadata, Viewport } from "next";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { CompareProvider } from "@/lib/compare-context";
import { CompareBar } from "@/components/compare-bar";
import "./globals.css";

const BASE_URL = "https://camp.fit";

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: "CampFit — Discover Denver Kids Camps",
    template: "%s | CampFit",
  },
  description:
    "Find the perfect summer, winter, and year-round camps for your kids in Denver. Search by age, activity, neighborhood, and availability.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "CampFit",
  },
  openGraph: {
    siteName: "CampFit",
    type: "website",
    locale: "en_US",
    url: BASE_URL,
    title: "CampFit — Discover Denver Kids Camps",
    description:
      "Find the perfect summer, winter, and year-round camps for your kids in Denver.",
  },
  twitter: {
    card: "summary_large_image",
    title: "CampFit — Denver Kids Camps",
    description:
      "Find the perfect summer, winter, and year-round camps for your kids in Denver.",
  },
  alternates: {
    canonical: BASE_URL,
  },
  other: {
    // llms.txt standard — https://llmstxt.org/
    "llms-txt": `${BASE_URL}/llms.txt`,
  },
};

export const viewport: Viewport = {
  themeColor: "#1B4332",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        <CompareProvider>
          <Nav />
          <main className="flex-1">{children}</main>
          <Footer />
          <CompareBar />
        </CompareProvider>
      </body>
    </html>
  );
}
