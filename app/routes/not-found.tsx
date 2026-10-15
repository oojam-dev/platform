import { data } from "react-router";

import { ErrorPage } from "../components/error-page";
import type { Route } from "./+types/not-found";

export const meta: Route.MetaFunction = () => [{ title: "Not found · oojam build" }];

export async function loader() {
  return data(null, { status: 404 });
}

export default function NotFound() {
  return <ErrorPage code="404" title="Nothing here (yet)." detail="That page doesn't exist. Maybe it should — post it as an idea?" />;
}
