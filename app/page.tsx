import { getDistinctCommunities } from "@/lib/camp-repository";
import { CityPicker } from "@/components/city-picker";

export const dynamic = "force-dynamic";

export const metadata = {
  // `absolute` opts out of the "%s | CampFit" template so the brand home
  // title isn't rendered as "… | CampFit" (avoids a redundant suffix).
  title: { absolute: "CampFit — Find Kids Camps in Your City" },
  description: "Discover the best kids camps in your city. Browse by age, activity, and availability.",
};

export default async function HomePage() {
  const communities = await getDistinctCommunities();
  return <CityPicker communities={communities} />;
}
