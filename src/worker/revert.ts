/** Reverts a merged build on main through a PR, after a failed deploy (SPEC §2.3 step 9). */
import { rmSync } from "node:fs";
import { join } from "node:path";

import { config } from "../core/config.js";
import { git } from "../guardrails/git.js";
import { openPullRequest, squashMerge, waitForChecks } from "./github.js";
import { freshCheckoutAt, pushBranch } from "./workspace.js";

export async function revertOnMain(sha: string, title: string, reason: string): Promise<string> {
  const root = join(config.dataDir, "reverts", sha.slice(0, 12));
  const { dirs } = await freshCheckoutAt({ root, gitDir: join(root, "repo.git"), workTree: join(root, "workspace") });
  try {
    await git(dirs, ["revert", "--no-edit", sha]);
    const head = (await git(dirs, ["rev-parse", "HEAD"])).trim();
    const branch = `revert/${sha.slice(0, 12)}`;
    await pushBranch(dirs, head, branch);
    const pr = await openPullRequest({ branch, title, body: `The deploy of ${sha} failed, and the previous version was restored. This reverts it so \`main\` matches what's live.\n\n${reason}` });
    const checks = await waitForChecks(head, 45 * 60_000);
    if (checks.failures.length) throw new Error(`revert CI failed: ${checks.failures.join("; ")}`);
    await squashMerge(pr.number, head, `${title} (#${pr.number})`, reason.slice(0, 2000));
    return pr.html_url;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
