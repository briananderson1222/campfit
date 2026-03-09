import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/auth/", "/api/"],
    },
    sitemap: "https://camp-scout-pied.vercel.app/sitemap.xml",
  };
}
