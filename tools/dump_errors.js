// Dumps full ERROR + MISSING list with source context for a given file,
// after applying the same preprocessor the realworld harness uses.
// Usage: node tools/dump_errors.js <path>

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { preprocessABL } = require("./preprocess_abl");

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node tools/dump_errors.js <path>");
  process.exit(1);
}

const TS = path.resolve(
  __dirname,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tree-sitter.cmd" : "tree-sitter",
);

const raw = fs.readFileSync(filePath, "latin1");
const source = preprocessABL(raw);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dump-err-"));
const tmpFile = path.join(tmpDir, path.basename(filePath));
fs.writeFileSync(tmpFile, source, "latin1");

const r = spawnSync(`"${TS}" parse "${tmpFile}"`, {
  encoding: "utf8",
  maxBuffer: 500 * 1024 * 1024,
  shell: true,
  windowsHide: true,
});

const text = (r.stdout || "") + (r.stderr || "");
const lines = source.split("\n");
const lineCount = lines.length;
const re = /\((ERROR|MISSING)\s+[^\[]*\[(\d+),\s*(\d+)\]\s*-\s*\[(\d+),\s*(\d+)\]/g;

let m;
let isFirst = true;
const seen = new Set();
while ((m = re.exec(text)) !== null) {
  const startRow = parseInt(m[2], 10);
  const endRow = parseInt(m[4], 10);
  if (
    isFirst &&
    m[1] === "ERROR" &&
    startRow === 0 &&
    endRow >= lineCount - 2
  ) {
    isFirst = false;
    continue;
  }
  isFirst = false;
  const key = `${m[1]}:${startRow}:${endRow}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const ctx = lines[startRow] || "";
  console.log(`${m[1]} L${startRow + 1}-L${endRow + 1}: ${ctx.trim().slice(0, 160)}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
