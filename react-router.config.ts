import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  allowedActionOrigins: [process.env.PLATFORM_HOST].filter((h): h is string => Boolean(h)),
} satisfies Config;
