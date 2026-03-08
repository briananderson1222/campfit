import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db";
import { getUserTier, FREE_SAVE_LIMIT } from "@/lib/tier";

// GET /api/saves — list the current user's saved camp IDs
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ savedIds: [] });
  }

  const pool = getPool();
  const result = await pool.query(
    `SELECT "campId" FROM "SavedCamp" WHERE "userId" = $1`,
    [user.id]
  );

  return NextResponse.json({
    savedIds: result.rows.map((r) => r.campId),
  });
}

// POST /api/saves — save a camp
export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { campId } = await request.json();
  if (!campId) {
    return NextResponse.json({ error: "campId required" }, { status: 400 });
  }

  const pool = getPool();

  // Ensure User row exists (lazy creation on first save)
  await pool.query(
    `INSERT INTO "User" (id, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       name = COALESCE(NULLIF(EXCLUDED.name, ''), "User".name)`,
    [user.id, user.email ?? "", user.user_metadata?.name ?? ""]
  );

  // Check save count — enforce limit for free tier only
  const tier = await getUserTier(user.id);
  if (tier === "FREE") {
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM "SavedCamp" WHERE "userId" = $1`,
      [user.id]
    );
    const count = parseInt(countResult.rows[0].count);
    if (count >= FREE_SAVE_LIMIT) {
      return NextResponse.json(
        { error: "Save limit reached", limit: FREE_SAVE_LIMIT },
        { status: 403 }
      );
    }
  }

  // Upsert the save
  await pool.query(
    `INSERT INTO "SavedCamp" (id, "userId", "campId")
     VALUES (gen_random_uuid()::text, $1, $2)
     ON CONFLICT ("userId", "campId") DO NOTHING`,
    [user.id, campId]
  );

  return NextResponse.json({ success: true });
}

// DELETE /api/saves?campId=xxx — remove a saved camp
export async function DELETE(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const campId = searchParams.get("campId");
  if (!campId) {
    return NextResponse.json({ error: "campId required" }, { status: 400 });
  }

  const pool = getPool();
  await pool.query(
    `DELETE FROM "SavedCamp" WHERE "userId" = $1 AND "campId" = $2`,
    [user.id, campId]
  );

  return NextResponse.json({ success: true });
}
