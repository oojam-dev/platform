import { useSearchParams } from "react-router";

import { Notice } from "~/components/ui";

/** Messages for the no-JavaScript vote flow, which redirects back with ?vote=<code>. */
const MESSAGES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  ok: { tone: "ok", text: "Vote counted." },
  removed: { tone: "ok", text: "Vote taken back." },
  banned: { tone: "warn", text: "This account is suspended." },
  vote_cap: { tone: "warn", text: "You've already voted for that idea." },
  idea_closed: { tone: "warn", text: "That idea isn't taking votes any more." },
  not_found: { tone: "warn", text: "That idea doesn't exist." },
  invalid: { tone: "warn", text: "That vote didn't go through." },
};

export function VoteNotice() {
  const [params] = useSearchParams();
  const code = params.get("vote");
  const m = code ? MESSAGES[code] : undefined;
  if (!m) return null;
  return (
    <Notice tone={m.tone} className="mb-6">
      {m.text}
    </Notice>
  );
}
