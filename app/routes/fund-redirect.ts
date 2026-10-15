import { redirect } from "react-router";

/** /fund became /costs when the build fund was replaced by a daily spend cap. */
export function loader() {
  return redirect("/costs", 301);
}
