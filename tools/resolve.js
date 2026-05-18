// CLI wrapper around tools/preprocess_resolve.js.
//
// Usage:
//   bun run resolve <entrypoint> [--propath dir1[:dir2…]] [--map] [--stats]
//
//   --propath    : ':' separated list (or ';' on Windows). Searched in order
//                  after the entrypoint's own directory.
//   --map        : emit JSON { virtualSource, sourceMap, diagnostics } to stdout
//                  instead of plain expanded source.
//   --stats      : print expansion stats to stderr (file count, byte count).
//
// Diagnostics always go to stderr. Plain mode prints virtualSource to stdout
// so the output can be piped into `tree-sitter parse -`.

const fs = require("node:fs");
const path = require("node:path");
const { expand } = require("./preprocess_resolve");

function parseArgs(argv) {
  const out = { entrypoint: null, propath: [], dumpMap: false, stats: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--propath") {
      const v = argv[++i] || "";
      const sep = process.platform === "win32" ? /[;]/ : /[:;]/;
      out.propath = v.split(sep).map((s) => s.trim()).filter(Boolean);
    } else if (a === "--map") out.dumpMap = true;
    else if (a === "--stats") out.stats = true;
    else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else if (!out.entrypoint) out.entrypoint = a;
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      printUsage();
      process.exit(2);
    }
  }
  if (!out.entrypoint) {
    printUsage();
    process.exit(2);
  }
  return out;
}

function printUsage() {
  process.stderr.write(
    "Usage: bun run resolve <entrypoint> [--propath dir1:dir2…] [--map] [--stats]\n",
  );
}

const args = parseArgs(process.argv);

const result = expand({
  entrypoint: path.resolve(args.entrypoint),
  propath: args.propath.map((p) => path.resolve(p)),
});

for (const d of result.diagnostics) {
  process.stderr.write(`[${d.severity}] ${d.message}\n`);
}

if (args.stats) {
  process.stderr.write(
    `[stats] files=${result.filesSeen.length} bytes=${result.virtualSource.length} segments=${result.sourceMap.segments.length}\n`,
  );
}

if (args.dumpMap) {
  process.stdout.write(
    JSON.stringify(
      {
        virtualSource: result.virtualSource,
        sourceMap: result.sourceMap,
        diagnostics: result.diagnostics,
        filesSeen: result.filesSeen,
      },
      null,
      2,
    ),
  );
} else {
  process.stdout.write(result.virtualSource);
}
