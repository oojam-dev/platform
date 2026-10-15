/** Secrets (SPEC §5.4) and static code patterns (SPEC §5.5), on added lines only. */
import type { ChangeSet, Finding, Severity } from "./types.js";

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic API key"],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/, "a Stripe live key"],
  [/\bwhsec_[A-Za-z0-9]{16,}/, "a Stripe webhook secret"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY/, "a private key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s'"]+:[^@\s'"]{6,}@/, "a database URL with a password"],
  [/\b[A-Z0-9_]*(?:SECRET|PASSWORD|API_KEY|PRIVATE_KEY|TOKEN)\s*[=:]\s*['"]?[A-Za-z0-9+/_\-]{24,}/, "a hard-coded secret"],
];

const CODE_FILE = /\.(?:[cm]?[jt]sx?|html?|svelte|vue)$/;

interface Pattern {
  re: RegExp;
  severity: Severity;
  message: string;
}

const ALLOWED_ENV = new Set(["DATABASE_URL", "PORT", "NODE_ENV", "GIT_SHA"]);

const PATTERNS: Pattern[] = [
  { re: /\beval\s*\(/, severity: "block", message: "eval() is not allowed." },
  { re: /\bnew\s+Function\s*\(/, severity: "block", message: "new Function() is not allowed." },
  { re: /\bchild_process\b|\bexecSync\b|\bspawnSync\b/, severity: "block", message: "Running processes is not allowed." },
  { re: /\bvm\.run\w*\s*\(|\bprocess\.binding\b|\bprocess\.dlopen\b/, severity: "block", message: "Low-level process and vm access is not allowed." },
  { re: /\bfrom\s+['"](?:node:)?(?:net|dgram|tls|dns|cluster|worker_threads|inspector)['"]/, severity: "block", message: "Network and process modules are not allowed; the site has no outbound access." },
  { re: /<script[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i, severity: "block", message: "Third-party scripts are not allowed." },
  { re: /\bimport\s*\(\s*["'`]https?:\/\//, severity: "block", message: "Importing code from a URL is not allowed." },
  {
    re: /\b(?:fetch|axios(?:\.\w+)?|got|ky|request|https?\.(?:get|request)|navigator\.sendBeacon)\s*\(\s*["'`](?:https?:)?\/\//,
    severity: "block",
    message: "Requests to other sites are not allowed; the site has no outbound access and the CSP blocks them in the browser.",
  },
  { re: /\bnew\s+(?:WebSocket|EventSource)\s*\(\s*["'`](?:wss?|https?):\/\//, severity: "block", message: "Connections to other sites are not allowed." },
  {
    re: /coinhive|cryptonight|stratum\+tcp|coin-?hive|webminer|googletagmanager|google-analytics|googlesyndication|facebook\.net|connect\.facebook|hotjar|segment\.(?:com|io)|mixpanel|fullstory|clarity\.ms|doubleclick/i,
    severity: "block",
    message: "Mining, tracking and ad-network code is not allowed.",
  },
  { re: /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/, severity: "warn", message: "Raw HTML injection; the reviewer must confirm the input is trusted or sanitised." },
  { re: /\bsql\.raw\s*\(|\.unsafe\s*\(/, severity: "warn", message: "Raw SQL; the reviewer must confirm nothing user-controlled reaches it." },
  { re: /\b(?:fs|fsp|promises)\.(?:write|append|rm|unlink|mkdir|rename|copy)\w*\s*\(|\bfrom\s+['"](?:node:)?fs(?:\/promises)?['"]/, severity: "warn", message: "Filesystem access; the site runs read-only except /tmp." },
  { re: /Math\.random\(\)/, severity: "warn", message: "Math.random() is not suitable for tokens or anything secret." },
  { re: /localStorage\.setItem\(\s*["'`][^"'`]*(?:token|password|secret)/i, severity: "warn", message: "Storing secrets in localStorage." },
];

export function checkContent(changes: ChangeSet): Finding[] {
  const findings: Finding[] = [];
  for (const f of changes.files) {
    if (f.status === "D" || f.binary) continue;
    const isLock = f.path === "package-lock.json";
    for (const { line, text } of f.added) {
      for (const [re, what] of SECRET_PATTERNS) {
        if (isLock && what === "a hard-coded secret") continue; // integrity hashes
        if (re.test(text)) {
          findings.push({ check: "secrets", severity: "block", file: f.path, line, message: `Looks like ${what}. Never commit credentials.` });
        }
      }
      if (!CODE_FILE.test(f.path) || f.path.includes(".test.")) continue;
      for (const p of PATTERNS) {
        if (p.re.test(text)) findings.push({ check: "patterns", severity: p.severity, file: f.path, line, message: p.message });
      }
      for (const m of text.matchAll(/process\.env(?:\.([A-Za-z_$][\w$]*)|\s*\[\s*["'`]([^"'`]+)["'`]\s*\]|(?![\w$.[]))/g)) {
        const name = m[1] ?? m[2];
        if (!name || !ALLOWED_ENV.has(name)) {
          findings.push({
            check: "patterns",
            severity: "block",
            file: f.path,
            line,
            message: `process.env${name ? `.${name}` : ""} is not allowed; the site only has ${[...ALLOWED_ENV].join(", ")}.`,
          });
        }
      }
    }
  }
  return findings;
}
