/** Shared shapes for the host-side guardrails (SPEC §5). */

export type Severity = "block" | "warn";

export interface Finding {
  check: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
}

export type ChangeStatus = "A" | "M" | "D" | "R" | "T";

/** One file the builder changed, as git sees it. Content is read from git blobs, never the filesystem. */
export interface ChangedFile {
  status: ChangeStatus;
  path: string;
  /** For renames, the path it came from. */
  oldPath?: string;
  /** git mode of the new file, e.g. 100644, 100755, 120000 (symlink). Empty when deleted. */
  mode: string;
  /** Size in bytes of the new blob (0 when deleted). */
  size: number;
  binary: boolean;
  /** New content (text files under 1 MB only). */
  content?: string;
  /** Content at the base commit, when the file existed there. */
  oldContent?: string;
  /** Lines added by this change, with their line number in the new file. */
  added: { line: number; text: string }[];
}

export interface ChangeSet {
  baseSha: string;
  headSha: string;
  files: ChangedFile[];
}

export function blocks(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "block");
}
