import { getPool } from '@/lib/db';

type StripeCustomerRow = {
  stripeCustomerId: string | null;
};

export function initializeStripeRepository(): void {
  getPool();
}

export async function getStripeCustomerId(userId: string): Promise<string | undefined> {
  const { rows } = await getPool().query<StripeCustomerRow>(
    `SELECT "stripeCustomerId" FROM "User" WHERE id = $1`,
    [userId]
  );
  return rows[0]?.stripeCustomerId ?? undefined;
}

export async function setStripeCustomerId(userId: string, customerId: string): Promise<void> {
  await getPool().query(
    `UPDATE "User" SET "stripeCustomerId" = $1 WHERE id = $2`,
    [customerId, userId]
  );
}

export async function setUserStripeSubscription(
  userId: string,
  subscriptionId: string,
  tier: 'PREMIUM' | 'FREE',
): Promise<void> {
  await getPool().query(
    `UPDATE "User" SET
      tier = $1::"UserTier",
      "stripeSubscriptionId" = $2
     WHERE id = $3`,
    [tier, subscriptionId, userId]
  );
}

export async function clearUserStripeSubscription(userId: string): Promise<void> {
  await getPool().query(
    `UPDATE "User" SET tier = 'FREE'::"UserTier", "stripeSubscriptionId" = NULL WHERE id = $1`,
    [userId]
  );
}
