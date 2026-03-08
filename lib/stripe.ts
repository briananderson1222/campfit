import Stripe from "stripe";

// Initialized lazily so missing key only throws at runtime, not build time
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    _stripe = new Stripe(key);
  }
  return _stripe;
}

// Monthly subscription price ID — set this after creating the product in Stripe
export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID ?? "";
