import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserTier } from "@/lib/tier";
import { DashboardClient } from "@/components/dashboard-client";
import { getSavedCamps } from "@/lib/save-repository";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/login");
  }

  const savedCamps = await getSavedCamps(user.id);

  const tier = await getUserTier(user.id);

  return (
    <DashboardClient
      initialSaves={savedCamps}
      userEmail={user.email ?? ""}
      isPremium={tier === "PREMIUM"}
    />
  );
}
