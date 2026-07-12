import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserTier, FREE_SAVE_LIMIT } from "@/lib/tier";
import { countSavedCamps, deleteSavedCamp, getSavedCampIds, saveCamp, upsertSaveUser } from "@/lib/save-repository";

// GET /api/saves — list the current user's saved camp IDs
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ savedIds: [] });
  }

  const savedIds = await getSavedCampIds(user.id);

  return NextResponse.json({
    savedIds,
  });
}

// POST /api/saves — save a camp
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { campId } = await request.json();
  if (!campId) {
    return NextResponse.json({ error: "campId required" }, { status: 400 });
  }

  // Ensure User row exists (lazy creation on first save)
  await upsertSaveUser({
    id: user.id,
    email: user.email ?? "",
    name: user.user_metadata?.name ?? "",
  });

  // Check save count — enforce limit for free tier only
  const tier = await getUserTier(user.id);
  if (tier === "FREE") {
    const count = parseInt(await countSavedCamps(user.id));
    if (count >= FREE_SAVE_LIMIT) {
      return NextResponse.json(
        { error: "Save limit reached", limit: FREE_SAVE_LIMIT },
        { status: 403 }
      );
    }
  }

  // Upsert the save
  await saveCamp(user.id, campId);

  return NextResponse.json({ success: true });
}

// DELETE /api/saves?campId=xxx — remove a saved camp
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const campId = searchParams.get("campId");
  if (!campId) {
    return NextResponse.json({ error: "campId required" }, { status: 400 });
  }

  await deleteSavedCamp(user.id, campId);

  return NextResponse.json({ success: true });
}
