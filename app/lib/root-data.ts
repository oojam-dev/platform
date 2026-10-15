import { useRouteLoaderData } from "react-router";

import type { loader } from "~/root";

export type RootData = Awaited<ReturnType<typeof loader>>;

/** The root loader's data. Undefined only when the root loader itself failed. */
export function useRootData(): RootData | undefined {
  return useRouteLoaderData<typeof loader>("root");
}
