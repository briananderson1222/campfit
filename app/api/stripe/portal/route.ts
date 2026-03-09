import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { getPool } from "@/lib/db";

export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const pool = getPool();
  const result = await pool.query(
    `SELECT "stripeCustomerId" FROM "User" WHERE id = $1`,
    [user.id]
  );
  const customerId = result.rows[0]?.stripeCustomerId;

  if (!customerId) {
    return NextResponse.json({ error: "No subscription found" }, { status: 404 });
  }

  const stripe = getStripe();
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? "https://camp.fit";

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/dashboard`,
  });

  return NextResponse.json({ url: session.url });
}
