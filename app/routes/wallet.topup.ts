/** POST /wallet/topup — start a Stripe Checkout session and send the browser to it (SPEC §6.5). */
import { redirect } from "react-router";

import { LedgerError } from "../../src/core/ledger.js";
import { parseTopupAmount, startCheckout } from "../../src/core/payments.js";
import { getDb } from "../../src/db/client.js";
import { requireMutation } from "../lib/session.server";
import type { Route } from "./+types/wallet.topup";

export async function loader() {
  return redirect("/wallet");
}

export async function action({ request }: Route.ActionArgs) {
  const { user, form } = await requireMutation(request);
  try {
    const cents = parseTopupAmount(form.get("amount"));
    const url = await startCheckout(getDb(), user, cents);
    return redirect(url);
  } catch (error) {
    if (error instanceof LedgerError) return redirect(`/wallet?topup=error&code=${error.code}`);
    console.error("wallet/topup: checkout failed:", error);
    return redirect("/wallet?topup=error&code=stripe");
  }
}
