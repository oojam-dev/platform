/**
 * The content policy (SPEC §2.4), in one place: shown on /rules, given to screening,
 * to the builder, and to the reviewer. Change it here and everywhere follows.
 */
export const POLICY_RULES: { id: string; rule: string }[] = [
  { id: "illegal", rule: "No illegal content, sexual content, hate, or harassment, and nothing about real private individuals." },
  { id: "malicious", rule: "No malware, crypto-mining, tracking, fingerprinting, ad networks or third-party scripts." },
  {
    id: "personal-data",
    rule: "No collecting personal data beyond what a feature strictly needs: no passwords, payment details or government IDs, and no email collection without a clear purpose.",
  },
  { id: "payments", rule: "No taking payments, and no impersonating any real person, brand or organisation." },
  { id: "network", rule: "No outbound network calls from the site. It has no internet access at runtime." },
  {
    id: "guardrails",
    rule: "No changing or weakening oojam's guardrails, the platform, voting, payments, the licence, CI or deploy configuration.",
  },
  {
    id: "preserve",
    rule: "No deleting or destructively changing data or features other ideas built. Restyling is fine; wiping a feature people voted for isn't.",
  },
  {
    id: "size",
    rule: "It has to be buildable in one day by an agent within the budget. Ideas that are too large are rejected with a suggestion to split them.",
  },
  {
    id: "ugc",
    rule: "Anything that publishes what visitors submit must escape it, limit its length, rate-limit it, and hide an item after 3 reports. Uploads (images, files) need the visitor signed in with GitHub, and show who posted them.",
  },
];

export const POLICY_TEXT = POLICY_RULES.map((r, i) => `${i + 1}. [${r.id}] ${r.rule}`).join("\n");

export const ABOUT_SITE = `oojam.dev is a website with no designated purpose. The community posts and votes on ideas, \
and each day the top idea is built by an AI agent into the open-source site (React Router v7, Tailwind, \
Drizzle + Postgres), merged automatically and deployed. Visitors can sign in with GitHub through oojam, but there are no passwords or other accounts. \
The site has no internet access at runtime, and a strict Content-Security-Policy (no third-party scripts, fonts, images or connections).`;
