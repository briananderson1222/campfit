import { MetadataRoute } from "next";
import { getCampSlugs, getDistinctCommunities } from "@/lib/camp-repository";

const BASE_URL = "https://camp.fit";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [slugs, communities] = await Promise.all([
    getCampSlugs(),
    getDistinctCommunities(),
  ]);

  const communityEntries: MetadataRoute.Sitemap = communities.flatMap(
    (community) => [
      {
        url: `${BASE_URL}/c/${community.communitySlug}`,
        lastModified: new Date(),
        changeFrequency: "daily" as const,
        priority: 0.9,
      },
      {
        url: `${BASE_URL}/c/${community.communitySlug}/calendar`,
        lastModified: new Date(),
        changeFrequency: "daily" as const,
        priority: 0.8,
      },
      {
        url: `${BASE_URL}/c/${community.communitySlug}/compare`,
        lastModified: new Date(),
        changeFrequency: "monthly" as const,
        priority: 0.6,
      },
    ]
  );

  const campEntries: MetadataRoute.Sitemap = slugs.map((camp) => ({
    url: `${BASE_URL}/c/${camp.communitySlug}/camps/${camp.slug}`,
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
    ...communityEntries,
    ...campEntries,
  ];
}
