// Synthetic tests for tools/preprocess_resolve.js.
//
// Runs in a fresh temp dir per test, exercises:
//   - {N} positional substitution
//   - {*} all-args expansion
//   - basic include resolution via propath
//   - nested includes
//   - cycle detection (no crash, diagnostic emitted)
//   - missing include (stub + diagnostic)
//   - quoted args with whitespace
//   - case-insensitive propath resolution
//   - sourcemap origin attribution
//
// Run: node tools/test_preprocess_resolve.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const { expand, segmentAt } = require("./preprocess_resolve");

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ts-abl-resolve-"));
}

function write(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "latin1");
  return p;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("positional {1} substitution", () => {
  const dir = mkdtemp();
  const inc = write(dir, "lib.i", "FIND FIRST {1} NO-LOCK.");
  const entry = write(dir, "main.p", "{lib.i clcondi}");
  const r = expand({ entrypoint: entry, propath: [dir] });
  assert.match(r.virtualSource, /FIND FIRST clcondi NO-LOCK\./);
  assert.equal(r.diagnostics.length, 0);
});

test("missing {1} emits warning and empty substitution", () => {
  const dir = mkdtemp();
  const inc = write(dir, "lib.i", "FIND FIRST {1}.");
  const entry = write(dir, "main.p", "{lib.i}");
  const r = expand({ entrypoint: entry, propath: [dir] });
  assert.match(r.virtualSource, /FIND FIRST \./);
  assert.equal(r.diagnostics.filter((d) => d.severity === "warn").length, 1);
});

test("{*} concatenates all args", () => {
  const dir = mkdtemp();
  write(dir, "lib.i", "MESSAGE {*}.");
  const entry = write(dir, "main.p", "{lib.i alpha beta gamma}");
  const r = expand({ entrypoint: entry, propath: [dir] });
  assert.match(r.virtualSource, /MESSAGE alpha beta gamma\./);
});

test("nested includes propagate their own args", () => {
  const dir = mkdtemp();
  write(dir, "outer.i", "OUTER {1} {inner.i bar}");
  write(dir, "inner.i", "INNER:{1}");
  const entry = write(dir, "main.p", "{outer.i foo}");
  const r = expand({ entrypoint: entry, propath: [dir] });
  // outer's {1} → foo, inner's {1} → bar
  assert.match(r.virtualSource, /OUTER foo INNER:bar/);
});

test("cycle detection stops without infinite loop", () => {
  const dir = mkdtemp();
  write(dir, "a.i", "A {b.i}");
  write(dir, "b.i", "B {a.i}");
  const entry = write(dir, "main.p", "{a.i}");
  const r = expand({ entrypoint: entry, propath: [dir] });
  assert.ok(r.diagnostics.some((d) => /cycle/i.test(d.message)));
  assert.match(r.virtualSource, /CYCLE: a\.i/);
});

test("missing include → stub + diagnostic, continues", () => {
  const dir = mkdtemp();
  const entry = write(dir, "main.p", "BEFORE {ghost.i} AFTER");
  const r = expand({ entrypoint: entry, propath: [dir] });
  assert.match(r.virtualSource, /BEFORE \/\* MISSING-INCLUDE: ghost\.i \*\/ AFTER/);
  assert.ok(r.diagnostics.some((d) => /not found/.test(d.message)));
});

test("quoted args with whitespace preserved", () => {
  const dir = mkdtemp();
  write(dir, "lib.i", "M({1}).");
  const entry = write(dir, "main.p", '{lib.i "hello world"}');
  const r = expand({ entrypoint: entry, propath: [dir] });
  assert.match(r.virtualSource, /M\(hello world\)\./);
});

test("case-insensitive propath resolution", () => {
  const dir = mkdtemp();
  write(dir, "MyLib.i", "FROM_MYLIB");
  const entry = write(dir, "main.p", "{mylib.i}");
  const r = expand({ entrypoint: entry, propath: [dir] });
  assert.match(r.virtualSource, /FROM_MYLIB/);
  assert.equal(r.diagnostics.length, 0);
});

test("propath fallback when not in entrypoint dir", () => {
  const root = mkdtemp();
  const src = path.join(root, "Src");
  const inc = path.join(root, "Includes");
  fs.mkdirSync(src);
  fs.mkdirSync(inc);
  write(inc, "shared.i", "SHARED");
  const entry = write(src, "main.p", "{shared.i}");
  const r = expand({ entrypoint: entry, propath: [inc] });
  assert.match(r.virtualSource, /SHARED/);
});

test("sourcemap: literal segment points back to source file/offset", () => {
  const dir = mkdtemp();
  const entry = write(dir, "main.p", "DEFINE VARIABLE x AS INT.");
  const r = expand({ entrypoint: entry, propath: [] });
  // Offset 7 in virtual ('V' of VARIABLE) maps to offset 7 in main.p
  const s = segmentAt(r.sourceMap, 7);
  assert.equal(s.origin, "literal");
  assert.equal(s.file, path.resolve(entry));
  assert.equal(7 - s.outStart + s.inStart, 7);
});

test("sourcemap: arg substitution has via pointing to caller", () => {
  const dir = mkdtemp();
  write(dir, "lib.i", "X {1} Y");
  const entry = write(dir, "main.p", "{lib.i WORLD}");
  const r = expand({ entrypoint: entry, propath: [dir] });
  const idx = r.virtualSource.indexOf("WORLD");
  assert.ok(idx >= 0);
  const s = segmentAt(r.sourceMap, idx);
  assert.equal(s.origin, "arg_substitution");
  assert.equal(s.file, path.resolve(dir, "lib.i"));
  // via should point at main.p where "WORLD" actually lives
  assert.ok(s.via, "via must be present on arg_substitution");
  assert.equal(s.via.file, path.resolve(entry));
  const callerText = fs.readFileSync(entry, "latin1");
  assert.equal(callerText.slice(s.via.inStart, s.via.inEnd), "WORLD");
});

test("string literal containing { is not mistaken for directive", () => {
  const dir = mkdtemp();
  const entry = write(dir, "main.p", 'MESSAGE "no {1} subst".');
  const r = expand({ entrypoint: entry, propath: [] });
  // {1} inside a string should remain literal
  assert.match(r.virtualSource, /no \{1\} subst/);
});

test("nested /* /* */ */ comment containing { is not a directive", () => {
  const dir = mkdtemp();
  const entry = write(dir, "main.p", "/* /* {nope.i} */ */ X");
  const r = expand({ entrypoint: entry, propath: [] });
  // No diagnostic should fire because we never enter the directive
  assert.equal(r.diagnostics.length, 0);
  assert.match(r.virtualSource, /\/\* \/\* \{nope\.i\} \*\/ \*\/ X/);
});

test("filesSeen lists every expanded file once", () => {
  const dir = mkdtemp();
  write(dir, "lib.i", "X");
  const entry = write(dir, "main.p", "{lib.i} {lib.i}");
  const r = expand({ entrypoint: entry, propath: [dir] });
  assert.equal(r.filesSeen.length, 2);
  assert.ok(r.filesSeen.some((p) => p.endsWith("main.p")));
  assert.ok(r.filesSeen.some((p) => p.endsWith("lib.i")));
});

// ===== P2 tests =====

test("P2: &SCOPED-DEFINE then {&NAME} substitutes", () => {
  const dir = mkdtemp();
  const entry = write(dir, "main.p", "&SCOPED-DEFINE TBL clcondi\nFIND FIRST {&TBL}.");
  const r = expand({ entrypoint: entry, propath: [] });
  assert.match(r.virtualSource, /FIND FIRST clcondi\./);
  assert.equal(r.diagnostics.length, 0);
});

test("P2: case-insensitive define name", () => {
  const dir = mkdtemp();
  const entry = write(dir, "main.p", "&SCOPED-DEFINE Foo bar\nX {&FOO} {&foo}");
  const r = expand({ entrypoint: entry, propath: [] });
  assert.match(r.virtualSource, /X bar bar/);
});

test("P2: &GLOBAL-DEFINE in include is visible after include returns", () => {
  const dir = mkdtemp();
  write(dir, "setup.i", "&GLOBAL-DEFINE T orders");
  const entry = write(dir, "main.p", "{setup.i}\nFOR EACH {&T}:");
  const r = expand({ entrypoint: entry, propath: [dir] });
  assert.match(r.virtualSource, /FOR EACH orders:/);
});

test("P2: &SCOPED-DEFINE in include does NOT leak to parent", () => {
  const dir = mkdtemp();
  write(dir, "inner.i", "&SCOPED-DEFINE X leaked\nINSIDE:{&X}");
  const entry = write(dir, "main.p", "{inner.i}\nOUTSIDE:{&X}");
  const r = expand({ entrypoint: entry, propath: [dir] });
  assert.match(r.virtualSource, /INSIDE:leaked/);
  // Outside the include, X is undefined → empty substitution and warn diag
  assert.match(r.virtualSource, /OUTSIDE:/);
  assert.doesNotMatch(r.virtualSource, /OUTSIDE:leaked/);
  assert.ok(r.diagnostics.some((d) => /\{&X\} referenced but undefined/.test(d.message)));
});

test("P2: &UNDEFINE removes a scoped define", () => {
  const dir = mkdtemp();
  const entry = write(
    dir,
    "main.p",
    "&SCOPED-DEFINE A one\n{&A}\n&UNDEFINE A\n{&A=fallback}",
  );
  const r = expand({ entrypoint: entry, propath: [] });
  assert.match(r.virtualSource, /one/);
  assert.match(r.virtualSource, /fallback/);
});

test("P2: named include arg {file.i &PARAM=value}", () => {
  const dir = mkdtemp();
  write(dir, "lib.i", "USING {&PARAM}");
  const entry = write(dir, "main.p", "{lib.i &PARAM=orders}");
  const r = expand({ entrypoint: entry, propath: [dir] });
  assert.match(r.virtualSource, /USING orders/);
});

test("P2: named arg precedence > scoped > global", () => {
  const dir = mkdtemp();
  // Global says "G", scoped in lib.i says "S", named arg says "N".
  // {&X} inside lib.i must resolve to "N".
  write(dir, "lib.i", "&SCOPED-DEFINE X S\nGOT:{&X}");
  const entry = write(dir, "main.p", "&GLOBAL-DEFINE X G\n{lib.i &X=N}");
  const r = expand({ entrypoint: entry, propath: [dir] });
  assert.match(r.virtualSource, /GOT:N/);
});

test("P2: {&NAME args} substitutes positionals inside define value", () => {
  const dir = mkdtemp();
  const entry = write(
    dir,
    "main.p",
    "&SCOPED-DEFINE GREET hello {1} from {2}\n{&GREET alice bob}",
  );
  const r = expand({ entrypoint: entry, propath: [] });
  assert.match(r.virtualSource, /hello alice from bob/);
});

test("P2: {&NAME=default} uses default when undefined", () => {
  const dir = mkdtemp();
  const entry = write(dir, "main.p", "X={&UNDEF=fallback}");
  const r = expand({ entrypoint: entry, propath: [] });
  assert.match(r.virtualSource, /X=fallback/);
});

test("P2: {&NAME=default} uses define value when defined (ignores default)", () => {
  const dir = mkdtemp();
  const entry = write(dir, "main.p", "&SCOPED-DEFINE A real\nX={&A=fallback}");
  const r = expand({ entrypoint: entry, propath: [] });
  assert.match(r.virtualSource, /X=real/);
});

test("P2: &MESSAGE / &ANALYZE-SUSPEND etc. are dropped", () => {
  const dir = mkdtemp();
  const entry = write(
    dir,
    "main.p",
    "BEFORE\n&MESSAGE just informative\n&ANALYZE-SUSPEND _CREATE-WINDOW\nAFTER",
  );
  const r = expand({ entrypoint: entry, propath: [] });
  assert.doesNotMatch(r.virtualSource, /informative/);
  assert.doesNotMatch(r.virtualSource, /ANALYZE-SUSPEND/);
  assert.match(r.virtualSource, /BEFORE/);
  assert.match(r.virtualSource, /AFTER/);
});

test("P2: continuation ~ joins multi-line define value", () => {
  const dir = mkdtemp();
  const entry = write(
    dir,
    "main.p",
    "&SCOPED-DEFINE LONG part1~\n   part2~\n   part3\nGOT:{&LONG}",
  );
  const r = expand({ entrypoint: entry, propath: [] });
  // Continuation collapses to single-line (whitespace preserved between parts)
  assert.match(r.virtualSource, /GOT:part1\s+part2\s+part3/);
});

test("P2: &IF first-branch only, &ELSE branch dropped", () => {
  const dir = mkdtemp();
  const entry = write(
    dir,
    "main.p",
    "&IF DEFINED(X) &THEN\nFIRST\n&ELSE\nSECOND\n&ENDIF\nAFTER",
  );
  const r = expand({ entrypoint: entry, propath: [] });
  assert.match(r.virtualSource, /FIRST/);
  assert.doesNotMatch(r.virtualSource, /SECOND/);
  assert.match(r.virtualSource, /AFTER/);
});

test("P2: nested &IF balances correctly", () => {
  const dir = mkdtemp();
  const entry = write(
    dir,
    "main.p",
    "&IF X &THEN\nA1\n&IF Y &THEN\nA2\n&ELSE\nA3\n&ENDIF\nA4\n&ELSE\nB1\n&ENDIF\nEND",
  );
  const r = expand({ entrypoint: entry, propath: [] });
  // First-branch-only: A1, A2, A4, END kept; A3, B1 dropped
  assert.match(r.virtualSource, /A1/);
  assert.match(r.virtualSource, /A2/);
  assert.match(r.virtualSource, /A4/);
  assert.match(r.virtualSource, /END/);
  assert.doesNotMatch(r.virtualSource, /A3/);
  assert.doesNotMatch(r.virtualSource, /B1/);
});

test("P2: define declared inside dropped &ELSE branch is NOT recorded", () => {
  const dir = mkdtemp();
  const entry = write(
    dir,
    "main.p",
    "&IF X &THEN\n&SCOPED-DEFINE A first\n&ELSE\n&SCOPED-DEFINE A second\n&ENDIF\nGOT:{&A}",
  );
  const r = expand({ entrypoint: entry, propath: [] });
  assert.match(r.virtualSource, /GOT:first/);
});

test("P2: sourcemap origin=define_expansion for {&NAME} substitution", () => {
  const dir = mkdtemp();
  const entry = write(dir, "main.p", "&SCOPED-DEFINE T users\nFIND FIRST {&T}.");
  const r = expand({ entrypoint: entry, propath: [] });
  const idx = r.virtualSource.indexOf("users");
  const s = segmentAt(r.sourceMap, idx);
  assert.equal(s.origin, "define_expansion");
  assert.equal(s.file, path.resolve(entry));
  assert.ok(s.via, "via should point to define declaration site");
  assert.equal(s.via.file, path.resolve(entry));
});

async function main() {
  let pass = 0;
  let fail = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
      pass++;
    } catch (e) {
      console.log(`  FAIL  ${name}`);
      console.log(`        ${e.message}`);
      if (e.stack) console.log(e.stack.split("\n").slice(1, 3).join("\n"));
      fail++;
    }
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
