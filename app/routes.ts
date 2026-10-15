import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("ideas/new", "routes/ideas.new.tsx"),
  route("ideas/:id", "routes/ideas.$id.tsx"),
  route("ideas/:id/vote", "routes/ideas.$id.vote.ts"),
  route("builds", "routes/builds.tsx"),
  route("builds/:id", "routes/builds.$id.tsx"),
  route("wallet", "routes/wallet.tsx"),
  route("wallet/topup", "routes/wallet.topup.ts"),
  route("fund", "routes/fund.tsx"),
  route("rules", "routes/rules.tsx"),
  route("transparency", "routes/transparency.tsx"),
  route("admin", "routes/admin.tsx"),
  route("auth/github", "routes/auth.github.ts"),
  route("auth/github/callback", "routes/auth.github.callback.tsx"),
  route("auth/logout", "routes/auth.logout.ts"),
  route("stripe/webhook", "routes/stripe.webhook.ts"),
  route("healthz", "routes/healthz.ts"),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
