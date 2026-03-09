import { MetadataRoute } from "next";
import { getCampSlugs } from "@/lib/camp-repository";

const BASE_URL = "https://camp-scout-pied.vercel.app";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const slugs = await getCampSlugs();

  const campEntries: MetadataRoute.Sitemap = slugs.map(({ slug }) => ({
    url: `${BASE_URL}/camps/${slug}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  return [
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${BASE_URL}/calendar`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/compare`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    ...campEntries,
  ];
}
