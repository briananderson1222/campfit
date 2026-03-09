import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe, STRIPE_PRICE_ID } from "@/lib/stripe";
import { getPool } from "@/lib/db";

export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const stripe = getStripe();
  const pool = getPool();

  // Get or create Stripe customer
  const userResult = await pool.query(
    `SELECT "stripeCustomerId" FROM "User" WHERE id = $1`,
    [user.id]
  );
  let customerId = userResult.rows[0]?.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: user.id },
    });
    customerId = customer.id;
    await pool.query(
      `UPDATE "User" SET "stripeCustomerId" = $1 WHERE id = $2`,
      [customerId, user.id]
    );
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? "https://camp.fit";

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${origin}/dashboard?upgraded=true`,
    cancel_url: `${origin}/dashboard`,
    allow_promotion_codes: true,
    subscription_data: {
      metadata: { userId: user.id },
    },
  });

  return NextResponse.json({ url: session.url });
}
