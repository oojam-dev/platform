import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // Read when the app is BUILT (in Docker, where PLATFORM_HOST isn't set), not at runtime, so
  // default to the production host. Behind Caddy the app sees http:// while browsers send
  // Origin: https://build.oojam.dev, so React Router needs the host listed to accept form posts.
  allowedActionOrigins: [process.env.PLATFORM_HOST || "build.oojam.dev"],
} satisfies Config;
