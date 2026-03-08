import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { getPool } from "@/lib/db";
import type Stripe from "stripe";

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "No signature" }, { status: 400 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, signature, webhookSecret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const pool = getPool();

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const userId = sub.metadata.userId;
      const isActive = sub.status === "active" || sub.status === "trialing";

      if (userId) {
        await pool.query(
          `UPDATE "User" SET
            tier = $1::"UserTier",
            "stripeSubscriptionId" = $2
           WHERE id = $3`,
          [isActive ? "PREMIUM" : "FREE", sub.id, userId]
        );
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const userId = sub.metadata.userId;

      if (userId) {
        await pool.query(
          `UPDATE "User" SET tier = 'FREE'::"UserTier", "stripeSubscriptionId" = NULL WHERE id = $1`,
          [userId]
        );
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      // Could send a payment-failed email here in the future
      console.warn("Payment failed for customer:", invoice.customer);
      break;
    }
  }

  return NextResponse.json({ received: true });
}
