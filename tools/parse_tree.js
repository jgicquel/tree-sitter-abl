// Bulk-parse every ABL source file under a directory (recursive) and
// report parse errors. Aggregates the failing source lines so you can
// spot common problem patterns across a whole project.
//
// Usage:
//   node tools/parse_tree.js <path>
//   node tools/parse_tree.js <path> --no-preprocess
//   node tools/parse_tree.js <path> --ext .p,.cls,.i
//   node tools/parse_tree.js <path> --top 30          # top 30 error groups
//   node tools/parse_tree.js <path> --quiet           # summary + groups only
//   node tools/parse_tree.js <path> --json            # machine-readable
//
// Notes:
//   * <path> can be a single file or a directory (recursed).
//   * Default extensions: .p .cls .i .w (case-insensitive).
//   * Preprocessor is ON by default (uses tools/preprocess_abl.js).
//   * Files that error out spawning tree-sitter are reported as SPAWN-ERR.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { preprocessABL } = require("./preprocess_abl");

function parseArgs(argv) {
  const args = { path: null, ext: [".p", ".cls", ".i", ".w"], preprocess: true, top: 20, quiet: false, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-preprocess") args.preprocess = false;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--json") args.json = true;
    else if (a === "--ext") args.ext = argv[++i].split(",").map((s) => s.trim().toLowerCase());
    else if (a === "--top") args.top = parseInt(argv[++i], 10);
    else if (!args.path) args.path = a;
  }
  if (!args.path) {
    console.error("Usage: node tools/parse_tree.js <path> [--no-preprocess] [--ext .p,.cls,.i] [--top N] [--quiet] [--json]");
    process.exit(1);
  }
  return args;
}

function walk(dir, exts, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      walk(p, exts, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (exts.includes(ext)) out.push(p);
    }
  }
}

function locateTreeSitter() {
  const local = path.resolve(
    __dirname,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tree-sitter.cmd" : "tree-sitter",
  );
  return fs.existsSync(local) ? local : "tree-sitter";
}

function summarizeLine(s) {
  return s.replace(/\s+/g, " ").trim().slice(0, 100);
}

function main() {
  const args = parseArgs(process.argv);
  const ts = locateTreeSitter();

  const stat = fs.statSync(args.path);
  const files = [];
  if (stat.isDirectory()) walk(args.path, args.ext, files);
  else if (stat.isFile()) files.push(args.path);
  else {
    console.error(`Not a file or directory: ${args.path}`);
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parse-tree-"));
  let counter = 0;

  const results = [];
  // Aggregate error line content across all files
  const groups = new Map(); // key: trimmed source line → { count, examples: [] }

  if (!args.json) {
    console.log(`Scanning ${files.length} files (preprocessor: ${args.preprocess ? "ON" : "OFF"})…`);
    console.log("");
  }

  let pass = 0;
  let fail = 0;
  let spawnErr = 0;
  const errorRe = /\(ERROR\s+[^\[]*\[(\d+),\s*(\d+)\]\s*-\s*\[(\d+),\s*(\d+)\]/g;
  const missingRe = /\(MISSING\s+[^\[]*\[(\d+),\s*(\d+)\]\s*-\s*\[(\d+),\s*(\d+)\]/g;

  for (const filePath of files) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "latin1");
    } catch (e) {
      spawnErr++;
      results.push({ path: filePath, status: "read-err", message: e.message });
      continue;
    }
    const source = args.preprocess ? preprocessABL(raw) : raw;
    const sourceLines = source.split("\n");
    const tmpFile = path.join(tmpDir, `${counter++}_${path.basename(filePath)}`);
    fs.writeFileSync(tmpFile, source, "latin1");

    const r = spawnSync(`"${ts}" parse "${tmpFile}"`, {
      encoding: "utf8",
      maxBuffer: 500 * 1024 * 1024,
      shell: true,
      windowsHide: true,
    });
    fs.unlinkSync(tmpFile);

    if (r.error || (!r.stdout && r.status !== 0)) {
      spawnErr++;
      results.push({ path: filePath, status: "spawn-err", message: (r.error?.message || r.stderr || "").slice(0, 200) });
      if (!args.json && !args.quiet) console.log(`[SPAWN-ERR] ${filePath}`);
      continue;
    }

    const text = r.stdout || "";
    const errors = (text.match(/\(ERROR\b/g) || []).length;
    const missing = (text.match(/\(MISSING\b/g) || []).length;

    // Detect root recovery wrapper (covers ~entire file)
    const lastIdx = sourceLines.length - 1;
    const rootMatch = text.match(/^\(ERROR \[0, 0\] - \[(\d+),/m);
    const rootIsWrapper = rootMatch && parseInt(rootMatch[1], 10) >= lastIdx - 1;
    const real = rootIsWrapper ? Math.max(0, errors - 1) : errors;

    // Collect per-error sample lines (skip root wrapper)
    let m;
    let isFirst = true;
    const innerErrors = [];
    errorRe.lastIndex = 0;
    while ((m = errorRe.exec(text)) !== null) {
      const startRow = parseInt(m[1], 10);
      const endRow = parseInt(m[3], 10);
      if (
        isFirst &&
        startRow === 0 &&
        endRow >= lastIdx - 1
      ) {
        isFirst = false;
        continue;
      }
      isFirst = false;
      const line = sourceLines[startRow] || "";
      innerErrors.push({ startLine: startRow + 1, endLine: endRow + 1, source: summarizeLine(line) });
    }
    missingRe.lastIndex = 0;
    while ((m = missingRe.exec(text)) !== null) {
      const startRow = parseInt(m[1], 10);
      const endRow = parseInt(m[3], 10);
      const line = sourceLines[startRow] || "";
      innerErrors.push({ startLine: startRow + 1, endLine: endRow + 1, source: summarizeLine(line), missing: true });
    }

    // Aggregate
    for (const e of innerErrors) {
      const key = e.source || "<empty>";
      if (!groups.has(key)) groups.set(key, { count: 0, files: new Set(), examples: [] });
      const g = groups.get(key);
      g.count++;
      g.files.add(filePath);
      if (g.examples.length < 3) g.examples.push({ file: path.basename(filePath), line: e.startLine });
    }

    if (real === 0 && missing === 0) {
      pass++;
      results.push({ path: filePath, status: "pass", lines: sourceLines.length });
      if (!args.json && !args.quiet) console.log(`[PASS] ${filePath}`);
    } else {
      fail++;
      results.push({ path: filePath, status: "fail", errors: real, missing, lines: sourceLines.length, samples: innerErrors.slice(0, 3) });
      if (!args.json && !args.quiet) {
        console.log(`[FAIL ${real} err${missing ? `, ${missing} missing` : ""}] ${filePath}`);
        for (const s of innerErrors.slice(0, 3)) {
          console.log(`        L${s.startLine}: ${s.source}`);
        }
      }
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Sort groups by count desc
  const sortedGroups = [...groups.entries()]
    .map(([source, g]) => ({ source, count: g.count, fileCount: g.files.size, examples: g.examples }))
    .sort((a, b) => b.count - a.count);

  if (args.json) {
    console.log(JSON.stringify({
      summary: { total: files.length, pass, fail, spawnErr },
      results,
      topGroups: sortedGroups.slice(0, args.top),
    }, null, 2));
    process.exit(fail + spawnErr > 0 ? 1 : 0);
  }

  console.log("");
  console.log("================================================================");
  console.log(`  SUMMARY: ${pass} pass / ${fail} fail / ${spawnErr} spawn-err  (total ${files.length})`);
  console.log("================================================================");

  if (sortedGroups.length > 0) {
    console.log("");
    console.log(`Top ${Math.min(args.top, sortedGroups.length)} error patterns (by occurrence):`);
    console.log("");
    const top = sortedGroups.slice(0, args.top);
    const countWidth = String(top[0].count).length;
    for (const g of top) {
      const countStr = String(g.count).padStart(countWidth);
      const filesStr = `${g.fileCount}f`.padStart(4);
      console.log(`  ${countStr}× ${filesStr}  ${g.source}`);
      const ex = g.examples.map((e) => `${e.file}:L${e.line}`).join(", ");
      console.log(`              ${ex}`);
    }
  }

  process.exit(fail + spawnErr > 0 ? 1 : 0);
}

main();
