// In-process bulk parser. Same interface as tools/parse_tree.js but uses
// the native tree-sitter binding directly instead of spawning the CLI per
// file — typically 10–50× faster on a large workspace. Add --threads N
// to fan out across worker threads (default 1; pass --threads auto for
// os.cpus().length).
//
// Requires the native binding (build/Release/tree_sitter_abl_binding.node)
// to be present. Build with `npx node-gyp rebuild`. On Linux / WSL this
// just works; on Windows the minified parser.c has one ~5 MB-long line
// that blows MSVC's compiler heap (C1060), so build there is currently
// broken — use parse_tree.js (CLI-spawn) on Windows or develop in WSL.
//
// Usage:
//   node tools/parse_tree_fast.js <path>
//   node tools/parse_tree_fast.js <path> --threads auto
//   node tools/parse_tree_fast.js <path> --threads 8 --no-preprocess
//   node tools/parse_tree_fast.js <path> --ext .p,.cls,.i --top 30 --quiet
//   node tools/parse_tree_fast.js <path> --json

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
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
    threads: 1,
    progress: 100, // stderr tick every N files completed; 0 to disable
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-preprocess") args.preprocess = false;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--json") args.json = true;
    else if (a === "--ext") args.ext = argv[++i].split(",").map((s) => s.trim().toLowerCase());
    else if (a === "--top") args.top = parseInt(argv[++i], 10);
    else if (a === "--progress") args.progress = parseInt(argv[++i], 10);
    else if (a === "--threads") {
      const v = argv[++i];
      args.threads = v === "auto" ? os.cpus().length : parseInt(v, 10);
    } else if (!args.path) args.path = a;
  }
  if (!args.path) {
    console.error(
      "Usage: node tools/parse_tree_fast.js <path> [--threads N|auto] [--no-preprocess] [--ext ...] [--top N] [--quiet] [--json]",
    );
    process.exit(1);
  }
  if (args.threads < 1) args.threads = 1;
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

// Visit ERROR / MISSING leaves iteratively. The first ERROR is skipped if it
// spans ~the whole file (root recovery wrapper).
function findInnerErrors(rootNode, source) {
  const lines = source.split("\n");
  const lineCount = lines.length;
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
      if (firstSkippable && isError && startRow === 0 && endRow >= lineCount - 2) {
        firstSkippable = false;
      } else {
        firstSkippable = false;
        found.push({
          type: isMissing ? "MISSING" : "ERROR",
          startLine: startRow + 1,
          endLine: endRow + 1,
          source: summarizeLine(lines[startRow] || ""),
        });
        continue;
      }
    }
    for (let i = node.childCount - 1; i >= 0; i--) stack.push(node.child(i));
  }
  return found;
}

function parseOne(parser, filePath, preprocess) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "latin1");
  } catch (e) {
    return { path: filePath, status: "read-err", message: e.message };
  }
  const source = preprocess ? preprocessABL(raw) : raw;
  const lineCount = source.split("\n").length;
  let tree;
  try {
    tree = parser.parse(source);
  } catch (e) {
    return { path: filePath, status: "parse-err", message: e.message, lines: lineCount };
  }
  const innerErrors = findInnerErrors(tree.rootNode, source);
  if (innerErrors.length === 0) {
    return { path: filePath, status: "pass", lines: lineCount };
  }
  return {
    path: filePath,
    status: "fail",
    errors: innerErrors.length,
    samples: innerErrors,
    lines: lineCount,
  };
}

// ----- Worker entry -----
if (!isMainThread) {
  const parser = new Parser();
  parser.setLanguage(Language);
  parentPort.on("message", (msg) => {
    if (msg === "exit") {
      parentPort.close();
      return;
    }
    const r = parseOne(parser, msg.filePath, msg.preprocess);
    parentPort.postMessage(r);
  });
  return;
}

// ----- Main thread -----
async function main() {
  const args = parseArgs(process.argv);

  const stat = fs.statSync(args.path);
  const files = [];
  if (stat.isDirectory()) walk(args.path, args.ext, files);
  else if (stat.isFile()) files.push(args.path);
  else {
    console.error(`Not a file or directory: ${args.path}`);
    process.exit(1);
  }

  if (!args.json) {
    const mode = args.threads > 1 ? `fast mode, ${args.threads} workers` : "fast mode, single-thread";
    console.log(`Scanning ${files.length} files (preprocessor: ${args.preprocess ? "ON" : "OFF"}) — ${mode}…`);
    console.log("");
  }

  const startMs = Date.now();
  const results = [];
  let pass = 0;
  let fail = 0;
  let err = 0;
  let done = 0;
  const groups = new Map();
  const total = files.length;

  const tickProgress = () => {
    if (!args.progress || args.progress <= 0) return;
    if (done % args.progress !== 0 && done !== total) return;
    const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
    const rate = done > 0 ? (done / Number(elapsedSec || 1)).toFixed(0) : "0";
    const etaSec =
      done > 0 && done < total
        ? (((Date.now() - startMs) / done) * (total - done) / 1000).toFixed(1)
        : "0";
    process.stderr.write(
      `\r  [${done}/${total}] ${pass} pass / ${fail} fail / ${err} err  —  ${elapsedSec}s elapsed, ~${rate} files/s, ETA ~${etaSec}s   `,
    );
    if (done === total) process.stderr.write("\n");
  };

  const accumulate = (r) => {
    done++;
    results.push(r);
    if (r.status === "pass") {
      pass++;
      if (!args.json && !args.quiet) console.log(`[PASS] ${r.path}`);
    } else if (r.status === "fail") {
      fail++;
      for (const e of r.samples) {
        const key = e.source || "<empty>";
        if (!groups.has(key)) groups.set(key, { count: 0, files: new Set(), examples: [] });
        const g = groups.get(key);
        g.count++;
        g.files.add(r.path);
        if (g.examples.length < 3)
          g.examples.push({ file: path.basename(r.path), line: e.startLine });
      }
      if (!args.json && !args.quiet) {
        console.log(`[FAIL ${r.errors} err] ${r.path}`);
        for (const s of r.samples.slice(0, 3)) {
          console.log(`        L${s.startLine}: ${s.source}`);
        }
      }
    } else {
      err++;
      if (!args.json && !args.quiet) console.log(`[${r.status.toUpperCase()}] ${r.path}: ${r.message}`);
    }
    tickProgress();
  };

  if (args.threads === 1) {
    // In-process loop, no worker overhead.
    const parser = new Parser();
    parser.setLanguage(Language);
    for (const filePath of files) {
      accumulate(parseOne(parser, filePath, args.preprocess));
    }
  } else {
    // Worker pool. Distribute via shared index counter.
    let nextIdx = 0;
    let pendingWorkers = 0;
    await new Promise((resolve) => {
      const workers = [];
      const tryDispatch = (w) => {
        if (nextIdx >= files.length) {
          w.postMessage("exit");
          return false;
        }
        w.postMessage({ filePath: files[nextIdx++], preprocess: args.preprocess });
        return true;
      };
      for (let i = 0; i < Math.min(args.threads, files.length); i++) {
        const w = new Worker(__filename, { workerData: {} });
        pendingWorkers++;
        w.on("message", (r) => {
          accumulate(r);
          tryDispatch(w);
        });
        w.on("exit", () => {
          pendingWorkers--;
          if (pendingWorkers === 0) resolve();
        });
        workers.push(w);
        tryDispatch(w);
      }
    });
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
          summary: { total: files.length, pass, fail, err, elapsedSec, threads: args.threads },
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
    `  SUMMARY: ${pass} pass / ${fail} fail / ${err} err  (total ${files.length}, ${elapsedSec}s, ${args.threads} worker${args.threads > 1 ? "s" : ""})`,
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
