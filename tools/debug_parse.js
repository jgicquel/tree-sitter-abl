// Debug helper: parse a file natively (no preprocessing), show top of AST and
// the source context around the first ERROR/MISSING node.
//
// Usage:
//   node tools/debug_parse.js <path> [--head=N]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--"));
const headArg = args.find((a) => a.startsWith("--head="));
const head = headArg ? parseInt(headArg.split("=")[1], 10) : 80;

if (!filePath) {
  console.error("Usage: node tools/debug_parse.js <path> [--head=N]");
  process.exit(2);
}

const raw = fs.readFileSync(filePath, "latin1");
const source = raw.replace(/\r/g, "");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-abl-debug-"));
const ext = path.extname(filePath) || ".i";
const tmpFile = path.join(tmpDir, "input" + ext);
fs.writeFileSync(tmpFile, source, "latin1");

const ts = path.resolve(
  __dirname,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tree-sitter.cmd" : "tree-sitter",
);

console.log(
  `File: ${path.basename(filePath)} (${source.split("\n").length} lines, native parse)`,
);

const result = spawnSync(`"${ts}" parse "${tmpFile}"`, {
  encoding: "utf8",
  maxBuffer: 500 * 1024 * 1024,
  shell: true,
});

const ast = result.stdout || "";
const stderr = result.stderr || "";

console.log(`Exit: ${result.status}`);
const errCount = (ast.match(/\(ERROR\b/g) || []).length;
const missCount = (ast.match(/\(MISSING\b/g) || []).length;
console.log(`(ERROR nodes: ${errCount}, (MISSING nodes: ${missCount})\n`);

if (stderr.trim()) {
  console.log("--- stderr ---");
  console.log(stderr.trim().slice(0, 500));
  console.log();
}

console.log(`--- AST head (first ${head} lines) ---`);
console.log(ast.split("\n").slice(0, head).join("\n"));

// Also show context around first ERROR / MISSING
const errMatch = ast.match(
  /\((ERROR|MISSING)[^[]*\[(\d+),\s*(\d+)\]\s*-\s*\[(\d+),\s*(\d+)\]/,
);
if (errMatch) {
  const startLine = parseInt(errMatch[2], 10);
  const endLine = parseInt(errMatch[4], 10);
  console.log(`\n--- First ${errMatch[1]} at lines ${startLine + 1}-${endLine + 1} (in preprocessed source) ---`);
  const lines = source.split("\n");
  for (let i = Math.max(0, startLine - 2); i <= Math.min(lines.length - 1, startLine + 5); i++) {
    const marker = i === startLine ? ">>> " : "    ";
    console.log(marker + (i + 1).toString().padStart(5) + " | " + (lines[i] || "").slice(0, 140));
  }
}

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {}
