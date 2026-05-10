// In-process bulk parser. Same interface as tools/parse_tree.js but uses
// the native tree-sitter binding directly instead of spawning the CLI per
// file — typically 10–50× faster on a large workspace.
//
// Requires the native binding (build/Release/tree_sitter_abl_binding.node)
// to be present. Build with `npx node-gyp rebuild`. On Linux/WSL this just
// works; on Windows it needs MSVC tweaks because the minified parser.c has
// a single ~5MB line that blows the default compiler heap (use parse_tree.js
// instead in that case).
//
// Usage:
//   node tools/parse_tree_fast.js <path>
//   node tools/parse_tree_fast.js <path> --no-preprocess
//   node tools/parse_tree_fast.js <path> --ext .p,.cls,.i
//   node tools/parse_tree_fast.js <path> --top 30
//   node tools/parse_tree_fast.js <path> --quiet
//   node tools/parse_tree_fast.js <path> --json

const fs = require("node:fs");
const path = require("node:path");
const Parser = require("tree-sitter");
const Language = require("../bindings/node");
const { preprocessABL } = require("./preprocess_abl");

function parseArgs(argv) {
  const args = {
    path: null,
    ext: [".p", ".cls", ".i", ".w"],
    preprocess: true,
    top: 20,
    quiet: false,
    json: false,
  };
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
    console.error(
      "Usage: node tools/parse_tree_fast.js <path> [--no-preprocess] [--ext ...] [--top N] [--quiet] [--json]",
    );
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

function summarizeLine(s) {
  return s.replace(/\s+/g, " ").trim().slice(0, 100);
}

// Walk the tree iteratively, collecting ERROR / MISSING leaves. The first
// ERROR is dropped if it spans ~the whole file (root recovery wrapper).
function findInnerErrors(rootNode, source) {
  const lineCount = source.split("\n").length;
  const lines = source.split("\n");
  const found = [];
  let firstSkippable = true;

  const stack = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    const isError = node.type === "ERROR";
    const isMissing = node.isMissing;

    if (isError || isMissing) {
      const startRow = node.startPosition.row;
      const endRow = node.endPosition.row;
      if (
        firstSkippable &&
        isError &&
        startRow === 0 &&
        endRow >= lineCount - 2
      ) {
        firstSkippable = false;
      } else {
        firstSkippable = false;
        found.push({
          type: isMissing ? "MISSING" : "ERROR",
          startLine: startRow + 1,
          endLine: endRow + 1,
          source: summarizeLine(lines[startRow] || ""),
        });
        continue; // don't descend into ERROR — too noisy
      }
    }
    // Push children in reverse so we visit in document order
    for (let i = node.childCount - 1; i >= 0; i--) stack.push(node.child(i));
  }
  return found;
}

function main() {
  const args = parseArgs(process.argv);
  const parser = new Parser();
  parser.setLanguage(Language);

  const stat = fs.statSync(args.path);
  const files = [];
  if (stat.isDirectory()) walk(args.path, args.ext, files);
  else if (stat.isFile()) files.push(args.path);
  else {
    console.error(`Not a file or directory: ${args.path}`);
    process.exit(1);
  }

  if (!args.json) {
    console.log(
      `Scanning ${files.length} files (preprocessor: ${args.preprocess ? "ON" : "OFF"}) — fast mode…`,
    );
    console.log("");
  }

  let pass = 0;
  let fail = 0;
  let err = 0;
  const results = [];
  const groups = new Map();

  const startMs = Date.now();
  for (const filePath of files) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "latin1");
    } catch (e) {
      err++;
      results.push({ path: filePath, status: "read-err", message: e.message });
      continue;
    }
    const source = args.preprocess ? preprocessABL(raw) : raw;
    const lineCount = source.split("\n").length;

    let tree;
    try {
      tree = parser.parse(source);
    } catch (e) {
      err++;
      results.push({ path: filePath, status: "parse-err", message: e.message });
      if (!args.json && !args.quiet) console.log(`[PARSE-ERR] ${filePath}`);
      continue;
    }

    const innerErrors = findInnerErrors(tree.rootNode, source);
    const real = innerErrors.length;

    for (const e of innerErrors) {
      const key = e.source || "<empty>";
      if (!groups.has(key)) groups.set(key, { count: 0, files: new Set(), examples: [] });
      const g = groups.get(key);
      g.count++;
      g.files.add(filePath);
      if (g.examples.length < 3)
        g.examples.push({ file: path.basename(filePath), line: e.startLine });
    }

    if (real === 0) {
      pass++;
      results.push({ path: filePath, status: "pass", lines: lineCount });
      if (!args.json && !args.quiet) console.log(`[PASS] ${filePath}`);
    } else {
      fail++;
      results.push({ path: filePath, status: "fail", errors: real, lines: lineCount });
      if (!args.json && !args.quiet) {
        console.log(`[FAIL ${real} err] ${filePath}`);
        for (const s of innerErrors.slice(0, 3)) {
          console.log(`        L${s.startLine}: ${s.source}`);
        }
      }
    }
  }
  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(2);

  const sortedGroups = [...groups.entries()]
    .map(([source, g]) => ({
      source,
      count: g.count,
      fileCount: g.files.size,
      examples: g.examples,
    }))
    .sort((a, b) => b.count - a.count);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          summary: { total: files.length, pass, fail, err, elapsedSec },
          results,
          topGroups: sortedGroups.slice(0, args.top),
        },
        null,
        2,
      ),
    );
    process.exit(fail + err > 0 ? 1 : 0);
  }

  console.log("");
  console.log("================================================================");
  console.log(
    `  SUMMARY: ${pass} pass / ${fail} fail / ${err} err  (total ${files.length}, ${elapsedSec}s)`,
  );
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

  process.exit(fail + err > 0 ? 1 : 0);
}

main();
