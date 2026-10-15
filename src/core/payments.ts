/** Stripe Checkout top-ups and the webhook (SPEC §6.5). */
import { eq } from "drizzle-orm";
import Stripe from "stripe";

import type { Database } from "../db/client.js";
import { stripeEvents, topups } from "../db/schema.js";
import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS, config } from "./config.js";
import { audit } from "./controls.js";
import { LedgerError, creditTopup, handleDispute } from "./ledger.js";

let stripeClient: Stripe | undefined;
export function stripe(): Stripe {
  stripeClient ??= new Stripe(config.stripeSecretKey);
  return stripeClient;
}

export function parseTopupAmount(raw: unknown): number {
  const dollars = Number(raw);
  const cents = Math.round(dollars * 100);
  if (!Number.isFinite(dollars) || !Number.isInteger(dollars) || cents < TOPUP_MIN_CENTS || cents > TOPUP_MAX_CENTS) {
    throw new LedgerError(
      "invalid",
      `Top up a whole number of dollars between $${TOPUP_MIN_CENTS / 100} and $${TOPUP_MAX_CENTS / 100}.`,
    );
  }
  return cents;
}

export async function startCheckout(db: Database, user: { id: number; bannedAt: Date | null }, cents: number): Promise<string> {
  if (user.bannedAt) throw new LedgerError("banned", "This account is suspended.");
  const [topup] = await db.insert(topups).values({ userId: user.id, amountCents: cents }).returning();
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe().checkout.sessions.create({
    mode: "payment",
    client_reference_id: String(user.id),
    metadata: { topup_id: String(topup!.id), user_id: String(user.id) },
    payment_intent_data: { metadata: { topup_id: String(topup!.id) } },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: cents,
          product_data: {
            name: `oojam credits ($${cents / 100})`,
            description: "Credits to post and vote on ideas. Committed credits are non-refundable.",
          },
        },
      },
    ],
    success_url: `${config.platformUrl}/wallet?topup=success`,
    cancel_url: `${config.platformUrl}/wallet?topup=cancelled`,
    });
  } catch (error) {
    await db.update(topups).set({ status: "failed" }).where(eq(topups.id, topup!.id));
    throw error;
  }
  await db.update(topups).set({ stripeCheckoutId: session.id }).where(eq(topups.id, topup!.id));
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  return session.url;
}

/** Verifies and applies one webhook delivery. Throws on a bad signature. */
export async function handleStripeWebhook(db: Database, rawBody: string, signature: string | null): Promise<string> {
  if (!signature) throw new WebhookSignatureError("missing signature");
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
  } catch (error) {
    throw new WebhookSignatureError(error instanceof Error ? error.message : "bad signature");
  }
  const fresh = await db.insert(stripeEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning();
  if (fresh.length === 0) return "duplicate";

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object;
        if (s.payment_status !== "paid") return "awaiting payment";
        const credited = await creditTopup(db, {
          checkoutId: s.id,
          paymentIntent: typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? null),
          amountCents: s.amount_total ?? 0,
        });
        return credited ? "credited" : "already credited";
      }
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        const s = event.data.object;
        await db.update(topups).set({ status: "failed" }).where(eq(topups.stripeCheckoutId, s.id));
        return "marked failed";
      }
      case "charge.dispute.created": {
        const d = event.data.object;
        const pi = typeof d.payment_intent === "string" ? d.payment_intent : d.payment_intent?.id;
        if (pi && (await handleDispute(db, pi))) {
          await audit(db, null, "dispute", `payment_intent:${pi}`, { amount: d.amount });
          return "dispute recorded";
        }
        return "dispute ignored";
      }
      default:
        return "ignored";
    }
  } catch (error) {
    // Let Stripe retry: forget we saw it.
    await db.delete(stripeEvents).where(eq(stripeEvents.id, event.id));
    throw error;
  }
}

export class WebhookSignatureError extends Error {}
