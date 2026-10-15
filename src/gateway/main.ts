import { createGateway } from "./server.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
const adminToken = process.env.GATEWAY_ADMIN_TOKEN;
if (!apiKey || !adminToken || adminToken.length < 32) {
  console.error("gateway: ANTHROPIC_API_KEY and GATEWAY_ADMIN_TOKEN (32+ chars) are required");
  process.exit(1);
}
const port = Number(process.env.GATEWAY_PORT ?? 8787);
const { server } = createGateway({ apiKey, adminToken });
server.listen(port, "0.0.0.0", () => console.log(`gateway: listening on ${port}`));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
