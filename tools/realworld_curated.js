// Real-world parser validation against a curated list of ABL source files.
//
// Spawns `tree-sitter parse` on each file and reports whether the resulting
// AST contains any (ERROR or (MISSING nodes. Each file has an expectation:
// PASS (no errors at all) or PARTIAL (only some blocks pass). Exit code 1
// if any file regresses below its expectation.
//
// Files are read as latin1 (Windows-1252 superset) so that legacy ABL
// sources written in non-UTF-8 encodings parse correctly.
//
// The file list lives in `tools/realworld_files.json` (machine-local,
// gitignored). Copy `tools/realworld_files.example.json` and edit. If the
// config file is missing, the harness exits cleanly with a hint.
//
// Usage: node tools/realworld_curated.js [--no-preprocess]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { preprocessABL } = require("./preprocess_abl");

const USE_PREPROCESSOR = !process.argv.includes("--no-preprocess");

const CONFIG_PATH = path.resolve(__dirname, "realworld_files.json");
const CONFIG_EXAMPLE = path.resolve(__dirname, "realworld_files.example.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`No config at ${CONFIG_PATH}.`);
    console.log(`Copy ${path.basename(CONFIG_EXAMPLE)} to ${path.basename(CONFIG_PATH)} and edit.`);
    process.exit(0);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!Array.isArray(raw) || raw.length === 0) {
    console.error(`${CONFIG_PATH} must be a non-empty array.`);
    process.exit(1);
  }
  return raw;
}

const FILES = loadConfig();

function locateTreeSitter() {
  const local = path.resolve(
    __dirname,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tree-sitter.cmd" : "tree-sitter",
  );
  if (fs.existsSync(local)) return local;
  return "tree-sitter";
}

function parseFile(treeSitterBin, filePath) {
  const isWin = process.platform === "win32";
  const quoted = `"${filePath}"`;
  const cmd = isWin ? `"${treeSitterBin}"` : treeSitterBin;
  const result = spawnSync(`${cmd} parse ${quoted}`, {
    encoding: "utf8",
    maxBuffer: 500 * 1024 * 1024,
    windowsHide: true,
    shell: true,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
}

function countErrors(astText) {
  const errors = (astText.match(/\(ERROR\b/g) || []).length;
  const missing = (astText.match(/\(MISSING\b/g) || []).length;
  return { errors, missing };
}

function firstFewErrors(astText, source, maxCount = 5) {
  const lines = source.split("\n");
  const lastLineIdx = lines.length - 1;
  const re =
    /\((ERROR|MISSING)\s+[^\[]*\[(\d+),\s*(\d+)\]\s*-\s*\[(\d+),\s*(\d+)\]/g;

  const found = [];
  let m;
  let isFirst = true;
  while ((m = re.exec(astText)) !== null && found.length < maxCount + 1) {
    const startRow = parseInt(m[2], 10);
    const endRow = parseInt(m[4], 10);
    if (
      isFirst &&
      m[1] === "ERROR" &&
      startRow === 0 &&
      endRow >= lastLineIdx - 1
    ) {
      isFirst = false;
      continue;
    }
    isFirst = false;
    found.push({
      type: m[1],
      startLine: startRow + 1,
      endLine: endRow + 1,
      sourceLine: (lines[startRow] || "").trim().slice(0, 100),
    });
  }
  return found.slice(0, maxCount);
}

async function main() {
  const treeSitter = locateTreeSitter();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-abl-realworld-"));

  console.log("================================================================");
  console.log("  REALWORLD CURATED VALIDATION");
  console.log(`  preprocessor: ${USE_PREPROCESSOR ? "ON" : "OFF"} (--no-preprocess to disable)`);
  console.log("================================================================\n");

  let allOk = true;
  const results = [];

  for (const entry of FILES) {
    process.stdout.write(`[${entry.label}] ... `);

    if (!fs.existsSync(entry.path)) {
      console.log("NOT FOUND");
      results.push({ ...entry, status: "missing" });
      continue;
    }

    const raw = fs.readFileSync(entry.path, "latin1");
    const source = USE_PREPROCESSOR ? preprocessABL(raw) : raw;

    const ext = path.extname(entry.path);
    const tmpFile = path.join(tmpDir, `${entry.label.replace(/[^\w.\-]/g, "_")}${ext}`);
    fs.writeFileSync(tmpFile, source, "latin1");

    const start = Date.now();
    const { exitCode, stdout, stderr, error } = parseFile(treeSitter, tmpFile);
    const elapsedMs = Date.now() - start;

    if (error) {
      console.log(`SPAWN ERROR: ${error.code || error.message}`);
      results.push({ ...entry, status: "spawn-error", elapsedMs });
      allOk = false;
      continue;
    }

    if (!stdout && exitCode !== 0) {
      console.log(
        `EXIT ${exitCode}: stderr="${stderr.trim().slice(0, 300)}"`,
      );
      results.push({ ...entry, status: "spawn-error", elapsedMs });
      allOk = false;
      continue;
    }

    const { errors, missing } = countErrors(stdout);
    const inner = firstFewErrors(stdout, source, 5);
    const lineCount = source.split("\n").length;

    const lastLineIdx = lineCount - 1;
    const rootIsWrapper = /^\(ERROR \[0, 0\] - \[(\d+),/m.test(stdout)
      ? parseInt(stdout.match(/^\(ERROR \[0, 0\] - \[(\d+),/m)[1], 10) >= lastLineIdx - 1
      : false;
    const realErrors = rootIsWrapper ? Math.max(0, errors - 1) : errors;

    let status;
    if (realErrors === 0 && missing === 0) {
      status = "pass";
    } else if (entry.expectation === "partial") {
      status = "partial";
    } else {
      status = "fail";
    }

    const summary =
      `${lineCount} lignes, ${realErrors} ERROR + ${missing} MISSING` +
      (rootIsWrapper ? " (root recovery)" : "") +
      `, ${elapsedMs} ms`;

    if (status === "pass") {
      console.log(`OK (${summary})`);
    } else if (status === "partial") {
      console.log(`PARTIAL (${summary}) [expected]`);
    } else {
      console.log(`FAIL (${summary})`);
      for (const e of inner) {
        console.log(
          `      ${e.type} L${e.startLine}-L${e.endLine}: ${e.sourceLine}`,
        );
      }
      allOk = false;
    }

    results.push({
      ...entry,
      status,
      errors: realErrors,
      missing,
      elapsedMs,
      lines: lineCount,
    });
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  console.log("\n================================================================");
  console.log(`  STATUS: ${allOk ? "TOUS OK (incluant PARTIAL attendus)" : "REGRESSION"}`);
  console.log("================================================================");

  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
