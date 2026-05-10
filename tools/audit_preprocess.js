// Audit which preprocessABL steps are still necessary given the modern
// grammar. For each step, runs the realworld harness with that step disabled
// and reports the per-file ERROR count delta vs all-on baseline.
//
// Usage: node tools/audit_preprocess.js
//
// A step is "still needed" if disabling it INCREASES errors on any file.
// A step is "redundant" if disabling it leaves error counts unchanged.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { preprocessABL } = require("./preprocess_abl");

const CONFIG_PATH = path.resolve(__dirname, "realworld_files.json");
if (!fs.existsSync(CONFIG_PATH)) {
  console.log(`No config at ${CONFIG_PATH}.`);
  console.log("Copy realworld_files.example.json and edit.");
  process.exit(0);
}
const FILES = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).map((e) => e.path);

const STEPS = [
  "nestedComments",
  "crlf",
  "ampersandLines",
  "proparseAnnotation",
  "argRefQualified",
  "argRefBare",
  "includeWithArgs",
  "namedDefineWithArgs",
];

const TS = path.resolve(
  __dirname,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tree-sitter.cmd" : "tree-sitter",
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-pp-"));

function parseAndCount(filePath, opts) {
  const raw = fs.readFileSync(filePath, "latin1");
  const source = preprocessABL(raw, opts);
  const tmpFile = path.join(tmpDir, path.basename(filePath));
  fs.writeFileSync(tmpFile, source, "latin1");
  const r = spawnSync(`"${TS}" parse "${tmpFile}"`, {
    encoding: "utf8",
    maxBuffer: 500 * 1024 * 1024,
    shell: true,
    windowsHide: true,
  });
  const text = (r.stdout || "") + (r.stderr || "");
  const errors = (text.match(/\(ERROR\b/g) || []).length;
  const lines = source.split("\n").length;
  // Exclude the root recovery wrapper if present
  const m = text.match(/^\(ERROR \[0, 0\] - \[(\d+),/m);
  const real = m && parseInt(m[1], 10) >= lines - 2 ? Math.max(0, errors - 1) : errors;
  return real;
}

(async () => {
  const labels = FILES.map((f) => path.basename(f));
  const baseline = {};
  console.log("Baseline (all steps ON):");
  for (let i = 0; i < FILES.length; i++) {
    baseline[labels[i]] = parseAndCount(FILES[i], {});
    console.log(`  ${labels[i]}: ${baseline[labels[i]]} ERR`);
  }
  console.log("");
  console.log("Per-step disabled:");
  console.log("");
  console.log(
    `${"step".padEnd(22)}  ${labels.map((l) => l.slice(0, 14).padEnd(14)).join("  ")}`,
  );
  for (const step of STEPS) {
    const counts = labels.map((_l, i) => parseAndCount(FILES[i], { [step]: false }));
    const deltas = labels.map((l, i) => counts[i] - baseline[l]);
    const cells = labels.map((_l, i) => {
      const d = deltas[i];
      const sign = d === 0 ? "·" : d > 0 ? `+${d}` : `${d}`;
      return `${counts[i]}(${sign})`.slice(0, 14).padEnd(14);
    });
    console.log(`${step.padEnd(22)}  ${cells.join("  ")}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
})();
