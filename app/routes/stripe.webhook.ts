/**
 * POST /stripe/webhook — Stripe events, verified against the raw body. Signature problems
 * are a 400 (Stripe won't retry); anything else is a 500 so Stripe retries later.
 */
import { WebhookSignatureError, handleStripeWebhook } from "../../src/core/payments.js";
import { getDb } from "../../src/db/client.js";
import type { Route } from "./+types/stripe.webhook";

export async function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const raw = await request.text();
  try {
    const result = await handleStripeWebhook(getDb(), raw, request.headers.get("stripe-signature"));
    return Response.json({ received: true, result });
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      return Response.json({ error: "invalid signature" }, { status: 400 });
    }
    console.error("stripe webhook: failed:", error);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
