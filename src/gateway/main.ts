import { createGateway } from "./server.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
const adminToken = process.env.GATEWAY_ADMIN_TOKEN;
if (!adminToken || adminToken.length < 32) {
  console.error("gateway: GATEWAY_ADMIN_TOKEN (32+ chars) is required");
  process.exit(1);
}
// Without a key the gateway still runs (health checks pass) but refuses to forward anything.
if (!apiKey) console.warn("gateway: ANTHROPIC_API_KEY is not set; builds will be refused until it is");
const port = Number(process.env.GATEWAY_PORT ?? 8787);
const { server } = createGateway({ apiKey: apiKey ?? "", adminToken });
server.listen(port, "0.0.0.0", () => console.log(`gateway: listening on ${port}`));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
