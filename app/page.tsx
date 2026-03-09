import { getDistinctCommunities } from "@/lib/camp-repository";
import { CityPicker } from "@/components/city-picker";

export const metadata = {
  title: "CampFit — Find Kids Camps in Your City",
  description: "Discover the best kids camps in your city. Browse by age, activity, and availability.",
};

export default async function HomePage() {
  const communities = await getDistinctCommunities();
  return <CityPicker communities={communities} />;
}
