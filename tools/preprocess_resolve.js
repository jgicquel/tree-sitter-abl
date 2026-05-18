// ABL preprocessor RESOLVER (P1 + P2).
//
// Unlike tools/preprocess_abl.js (a NORMALIZER that turns unresolved
// placeholders into stub identifiers so an isolated .i can parse), this
// module actually EXPANDS the source: it follows {include.i args}, resolves
// &SCOPED-DEFINE / &GLOBAL-DEFINE, substitutes {N} / {*} / {&NAME}, and
// produces a virtual source + sourcemap that lets a consumer trace every
// byte of the expanded output back to its real file origin.
//
// Scope:
//   P1 (done):
//     - {N}, {*}, {&*} positional substitution
//     - {file.ext args} include resolution via propath, recursive
//     - Cycle detection, missing-include stubs, quoted args
//   P2 (this iteration):
//     - &SCOPED-DEFINE NAME val      → file-local define
//     - &GLOBAL-DEFINE NAME val      → cross-file define (mutable shared state)
//     - &UNDEFINE NAME               → removes from current scope (then global)
//     - {&NAME}                      → lookup with priority named-arg > scoped > global
//     - {&NAME=default}              → same, with inline fallback if undefined
//     - {&NAME arg1 arg2}            → substitute {1}/{2}/... inside define value
//     - {file.i &PARAM=val pos1}     → named include args, available as {&PARAM}
//     - &IF / &ELSEIF / &ELSE / &ENDIF → first-branch-only (no condition eval, P3)
//     - All other &-directive lines (&MESSAGE, &ANALYZE-..., {&_proparse_*}) dropped
//     - Continuation lines via ~ at end of line
// NOT in P2:
//   - &IF condition evaluation (DEFINED(), equality, AND/OR) — P3
//   - Recursive define expansion within define values — limited (one level only)
//
// Public API:
//   expand({ entrypoint, propath, defines?, encoding?, maxDepth? })
//     → { virtualSource, sourceMap: { segments }, diagnostics, filesSeen }

const fs = require("node:fs");
const path = require("node:path");

// === Segment builder ===
//
// A segment maps a range in the virtual (expanded) source back to a real
// on-disk file. `origin` qualifies the bytes:
//   - 'literal'           : copied as-is
//   - 'arg_substitution'  : {N}/{*}/{&*} replaced; `via` points to arg origin
//   - 'define_expansion'  : {&NAME} replaced; `via` points to define site
//   - 'include_callsite'  : zero-width marker before/after include expansion
//   - 'synthesized'       : no real source (stub for missing/cycle)

function makeBuilder() {
  let out = "";
  const segments = [];
  function emit(text, seg) {
    const outStart = out.length;
    out += text;
    if (out.length === outStart && seg.origin !== "include_callsite") return;
    segments.push({ outStart, outEnd: out.length, ...seg });
  }
  return {
    emit,
    get source() {
      return out;
    },
    get segments() {
      return segments;
    },
  };
}

// === Comment/string-aware directive locator ===
//
// Returns the position and kind of the next preprocessor directive starting
// from `from`. Skips /* nested comments */ and "strings" / 'strings'.
//   kind: 'brace' (next `{`)
//   kind: 'amp'   (next `&` at start of a logical line)
//   kind: 'eof'   (no more)

function findNextDirective(src, from) {
  let i = from;
  let atLineStart = from === 0 || src[from - 1] === "\n";
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      atLineStart = false;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "~") i += 2;
        else i++;
      }
      if (i < src.length) i++;
      atLineStart = false;
      continue;
    }
    if (c === "{") return { at: i, kind: "brace" };
    if (atLineStart && c === "&") return { at: i, kind: "amp" };
    if (c === "\n") {
      atLineStart = true;
    } else if (c !== " " && c !== "\t" && c !== "\r") {
      atLineStart = false;
    }
    i++;
  }
  return { at: src.length, kind: "eof" };
}

// === Argument tokenizer ===
//
// Parses the args portion of `{file.i …}` or `{&NAME …}`. Recognizes:
//   - "quoted strings" → single token, quotes stripped
//   - &NAME=value      → named arg (case-insensitive name, upper-cased internally)
//   - bare tokens      → positional
//
// Returns { positional: [{value, start, end}], named: Map<NAME_UPPER, {value, start, end}> }
// where start/end are absolute offsets in the containing source (baseOffset + local).

function tokenizeArgs(raw, baseOffset) {
  const positional = [];
  const named = new Map();
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i >= raw.length) break;
    // Named: &NAME=value
    if (raw[i] === "&") {
      const m = raw.slice(i).match(/^&([A-Za-z_][\w-]*)\s*=/);
      if (m) {
        const name = m[1].toUpperCase();
        let j = i + m[0].length;
        let valStart, valEnd, value;
        if (raw[j] === '"') {
          valStart = j + 1;
          j = valStart;
          while (j < raw.length && raw[j] !== '"') j++;
          valEnd = j;
          value = raw.slice(valStart, valEnd);
          if (j < raw.length) j++;
        } else {
          valStart = j;
          while (j < raw.length && !/\s/.test(raw[j])) j++;
          valEnd = j;
          value = raw.slice(valStart, valEnd);
        }
        named.set(name, { value, start: baseOffset + valStart, end: baseOffset + valEnd });
        i = j;
        continue;
      }
    }
    // Positional
    if (raw[i] === '"') {
      const start = i + 1;
      let j = start;
      while (j < raw.length && raw[j] !== '"') j++;
      positional.push({ value: raw.slice(start, j), start: baseOffset + start, end: baseOffset + j });
      i = j < raw.length ? j + 1 : j;
    } else {
      const start = i;
      while (i < raw.length && !/\s/.test(raw[i])) i++;
      positional.push({ value: raw.slice(start, i), start: baseOffset + start, end: baseOffset + i });
    }
  }
  return { positional, named };
}

// === Brace directive scanner ===
//
// Recognizes (in order):
//   {N}                                 → argRef
//   {*}, {&*}                           → starArg
//   {&NAME}, {&NAME=default}            → defineRef (no args)
//   {&NAME arg1 arg2}                   → defineRef (with args)
//   {file.ext args}                     → include
// Returns null if the brace does not introduce a recognized directive.

function scanBraceDirective(src, at) {
  if (src[at] !== "{") return null;
  const bodyStart = at + 1;
  let m;

  // {N}
  m = src.slice(bodyStart).match(/^(\d+)\}/);
  if (m) return { kind: "argRef", n: parseInt(m[1], 10), end: bodyStart + m[0].length };

  // {*}
  m = src.slice(bodyStart).match(/^\*\}/);
  if (m) return { kind: "starArg", end: bodyStart + m[0].length };

  // {&NAME ...} or {&NAME=default} or {&*}
  if (src[bodyStart] === "&") {
    if (src[bodyStart + 1] === "*" && src[bodyStart + 2] === "}") {
      return { kind: "starArg", end: bodyStart + 3 };
    }
    const nm = src.slice(bodyStart + 1).match(/^([A-Za-z_][\w-]*)/);
    if (nm) {
      const name = nm[1].toUpperCase();
      let j = bodyStart + 1 + nm[0].length;
      let defaultValue = null;
      let defaultStart = -1;
      let defaultEnd = -1;
      if (src[j] === "=") {
        // {&NAME=default}  — default value is everything up to matching }
        // (no nested braces expected here for P2)
        j++;
        defaultStart = j;
        let depth = 1;
        while (j < src.length && depth > 0) {
          if (src[j] === "{") depth++;
          else if (src[j] === "}") {
            depth--;
            if (depth === 0) break;
          }
          j++;
        }
        if (depth !== 0) return null;
        defaultEnd = j;
        defaultValue = src.slice(defaultStart, defaultEnd);
        return { kind: "defineRef", name, defaultValue, defaultStart, defaultEnd, argsRaw: "", argsOffset: j, end: j + 1 };
      }
      // {&NAME args}  — args until matching }
      let depth = 1;
      const argsStart = j;
      while (j < src.length && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      if (depth !== 0) return null;
      return {
        kind: "defineRef",
        name,
        defaultValue: null,
        defaultStart: -1,
        defaultEnd: -1,
        argsRaw: src.slice(argsStart, j),
        argsOffset: argsStart,
        end: j + 1,
      };
    }
    return null;
  }

  // {file.ext args}
  m = src.slice(bodyStart).match(/^([A-Za-z0-9_\-\\/.~]+\.[A-Za-z][A-Za-z0-9]*)/);
  if (m) {
    const file = m[1];
    let j = bodyStart + m[0].length;
    let depth = 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
      j++;
    }
    if (depth !== 0) return null;
    return {
      kind: "include",
      file,
      argsRaw: src.slice(bodyStart + m[0].length, j),
      argsOffset: bodyStart + m[0].length,
      end: j + 1,
    };
  }

  return null;
}

// === &-directive scanner ===
//
// Returns { name (UPPER), body (post-name, includes continuation joining),
//   bodyStart, bodyEnd (raw), end (after final \n) } or null.
// Handles `~`-continuation: body extends across newlines until a line lacks
// trailing `~`.

function scanAmpDirective(src, at) {
  if (src[at] !== "&") return null;
  const m = src.slice(at).match(/^&([A-Za-z][A-Za-z0-9-]*)/);
  if (!m) return null;
  const name = m[1].toUpperCase();
  const bodyStart = at + m[0].length;
  let i = bodyStart;
  // Logical line: extend across ~-continuations.
  while (i < src.length) {
    if (src[i] === "\n") {
      let k = i - 1;
      while (k >= bodyStart && (src[k] === " " || src[k] === "\t" || src[k] === "\r")) k--;
      if (k >= bodyStart && src[k] === "~") {
        i++;
        continue;
      }
      break;
    }
    i++;
  }
  return { name, bodyStart, bodyEnd: i, end: i < src.length ? i + 1 : i };
}

// Strip ~\n joiners from a logical line body, collapsing the continuation
// into a single line for define values.
function cleanContinuation(body) {
  return body.replace(/~[ \t]*\r?\n[ \t]*/g, " ");
}

// === Propath include resolution ===
//
// Tries entrypoint dir first, then each propath entry. Case-insensitive
// fallback walks dirents per segment (cheap, only when direct hit fails).

function resolveInclude(name, propath, currentDir) {
  const normalized = name.replace(/\\/g, "/");

  function tryDir(dir) {
    const direct = path.resolve(dir, normalized);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
    const parts = normalized.split("/");
    let cur = path.resolve(dir);
    for (const part of parts) {
      const want = part.toLowerCase();
      let entries;
      try {
        entries = fs.readdirSync(cur);
      } catch {
        return null;
      }
      const hit = entries.find((e) => e.toLowerCase() === want);
      if (!hit) return null;
      cur = path.join(cur, hit);
    }
    if (fs.existsSync(cur) && fs.statSync(cur).isFile()) return cur;
    return null;
  }

  const here = tryDir(currentDir);
  if (here) return here;
  for (const dir of propath) {
    const got = tryDir(dir);
    if (got) return got;
  }
  return null;
}

// === Main expand ===

function expand(opts) {
  const {
    entrypoint,
    propath = [],
    encoding = "latin1",
    maxDepth = 50,
    defines = {},
  } = opts;

  const builder = makeBuilder();
  const diagnostics = [];
  const filesSeen = new Set();
  // Mutable, shared across the whole expansion.
  const globalDefines = new Map();
  for (const [k, v] of Object.entries(defines)) {
    globalDefines.set(k.toUpperCase(), { value: String(v), sourceFile: "<preseed>", start: -1, end: -1 });
  }

  // Substitute {N} positional references inside a stored define value, using
  // the args supplied at the {&NAME …} call site. P2 keeps this a single
  // pass — no recursive define expansion inside define values (deferred).
  function substituteInDefineValue(value, posArgs) {
    return value.replace(/\{(\d+)\}/g, (_m, d) => {
      const a = posArgs[parseInt(d, 10) - 1];
      return a ? a.value : "";
    });
  }

  // Expand one file. `posArgs`/`namedArgs` come from the caller's include
  // invocation; `stack` is the chain of currently-expanding absolute paths
  // (cycle guard). `scopedDefines` is freshly created (file-local).
  function expandFile(filePath, posArgs, namedArgs, stack) {
    if (stack.length > maxDepth) {
      diagnostics.push({
        severity: "error",
        message: `max include depth ${maxDepth} exceeded at ${filePath}`,
        file: filePath,
      });
      return;
    }
    const abs = path.resolve(filePath);
    if (stack.includes(abs)) {
      diagnostics.push({
        severity: "error",
        message: `include cycle: ${[...stack, abs].join(" → ")}`,
        file: abs,
      });
      builder.emit(`/* CYCLE: ${path.basename(abs)} */`, {
        file: abs,
        inStart: 0,
        inEnd: 0,
        origin: "synthesized",
      });
      return;
    }
    let src;
    try {
      src = fs.readFileSync(abs, encoding);
    } catch (e) {
      diagnostics.push({
        severity: "error",
        message: `cannot read ${abs}: ${e.message}`,
        file: abs,
      });
      builder.emit(`/* READ-FAIL: ${path.basename(abs)} */`, {
        file: abs,
        inStart: 0,
        inEnd: 0,
        origin: "synthesized",
      });
      return;
    }
    filesSeen.add(abs);

    const scopedDefines = new Map();
    // ifStack frame: { emitting: bool } — emitting=true means we're still in
    // the first branch and should produce output. Set to false on
    // &ELSEIF/&ELSE, popped on &ENDIF.
    const ifStack = [];
    const emitting = () => ifStack.every((f) => f.emitting);

    // {&NAME} resolution priority: named arg > scoped > global.
    function lookupDefine(name) {
      const key = name.toUpperCase();
      if (namedArgs.has(key)) return { ...namedArgs.get(key), source: "namedArg" };
      if (scopedDefines.has(key)) return { ...scopedDefines.get(key), source: "scoped" };
      if (globalDefines.has(key)) return { ...globalDefines.get(key), source: "global" };
      return null;
    }

    let cursor = 0;
    while (cursor < src.length) {
      const next = findNextDirective(src, cursor);

      // Emit literal chunk up to next directive — only when not in a
      // suppressed &IF branch.
      if (next.at > cursor && emitting()) {
        builder.emit(src.slice(cursor, next.at), {
          file: abs,
          inStart: cursor,
          inEnd: next.at,
          origin: "literal",
        });
      }
      cursor = next.at;
      if (next.kind === "eof") break;

      // -------- & directive --------
      if (next.kind === "amp") {
        const dir = scanAmpDirective(src, cursor);
        if (!dir) {
          cursor++;
          continue;
        }
        const ctrl = dir.name;
        // Control-flow directives mutate ifStack even when suppressed (so
        // nested &IFs balance properly).
        if (ctrl === "IF") {
          ifStack.push({ emitting: emitting() });
          cursor = dir.end;
          continue;
        }
        if (ctrl === "ELSEIF" || ctrl === "ELSE") {
          if (ifStack.length > 0) ifStack[ifStack.length - 1].emitting = false;
          cursor = dir.end;
          continue;
        }
        if (ctrl === "THEN") {
          // Stray &THEN on its own line — skip.
          cursor = dir.end;
          continue;
        }
        if (ctrl === "ENDIF") {
          if (ifStack.length > 0) ifStack.pop();
          cursor = dir.end;
          continue;
        }
        // Non-control directives are only acted upon when actively emitting.
        if (!emitting()) {
          cursor = dir.end;
          continue;
        }
        const rawBody = src.slice(dir.bodyStart, dir.bodyEnd);
        const cleanedBody = cleanContinuation(rawBody).trim();
        if (ctrl === "SCOPED-DEFINE" || ctrl === "GLOBAL-DEFINE") {
          const nm = cleanedBody.match(/^([A-Za-z_][\w-]*)\s*(.*)$/);
          if (nm) {
            const key = nm[1].toUpperCase();
            const val = nm[2];
            const entry = {
              value: val,
              sourceFile: abs,
              start: dir.bodyStart,
              end: dir.bodyEnd,
            };
            if (ctrl === "GLOBAL-DEFINE") globalDefines.set(key, entry);
            else scopedDefines.set(key, entry);
          }
        } else if (ctrl === "UNDEFINE") {
          const key = cleanedBody.toUpperCase().split(/\s+/)[0];
          if (scopedDefines.has(key)) scopedDefines.delete(key);
          else if (globalDefines.has(key)) globalDefines.delete(key);
        }
        // All other &-directives (&MESSAGE, &ANALYZE-..., etc.) are dropped.
        cursor = dir.end;
        continue;
      }

      // -------- { directive --------
      const d = scanBraceDirective(src, cursor);
      if (!d) {
        // Not a known directive — keep the `{` as literal.
        if (emitting()) {
          builder.emit(src[cursor], {
            file: abs,
            inStart: cursor,
            inEnd: cursor + 1,
            origin: "literal",
          });
        }
        cursor++;
        continue;
      }
      if (!emitting()) {
        cursor = d.end;
        continue;
      }
      if (d.kind === "argRef") {
        const a = posArgs[d.n - 1];
        if (a) {
          builder.emit(a.value, {
            file: abs,
            inStart: cursor,
            inEnd: d.end,
            origin: "arg_substitution",
            via: { file: a.sourceFile, inStart: a.start, inEnd: a.end },
          });
        } else {
          diagnostics.push({
            severity: "warn",
            message: `{${d.n}} referenced but no arg supplied in ${abs}`,
            file: abs,
            offset: cursor,
          });
        }
        cursor = d.end;
        continue;
      }
      if (d.kind === "starArg") {
        const joined = posArgs.map((a) => a.value).join(" ");
        builder.emit(joined, {
          file: abs,
          inStart: cursor,
          inEnd: d.end,
          origin: "arg_substitution",
          via: posArgs.length
            ? { file: posArgs[0].sourceFile, inStart: posArgs[0].start, inEnd: posArgs[posArgs.length - 1].end }
            : undefined,
        });
        cursor = d.end;
        continue;
      }
      if (d.kind === "defineRef") {
        const hit = lookupDefine(d.name);
        if (hit) {
          let text = hit.value;
          // {&NAME args} → substitute {1}/{2}/... in the define value
          if (d.argsRaw && d.argsRaw.length > 0) {
            const sub = tokenizeArgs(d.argsRaw, d.argsOffset);
            // Tag arg origins so the define value's `{N}` can attribute via.
            const taggedPos = sub.positional.map((a) => ({ ...a, sourceFile: abs }));
            text = substituteInDefineValue(hit.value, taggedPos);
          }
          builder.emit(text, {
            file: abs,
            inStart: cursor,
            inEnd: d.end,
            origin: "define_expansion",
            via: hit.start >= 0 ? { file: hit.sourceFile, inStart: hit.start, inEnd: hit.end } : undefined,
          });
        } else if (d.defaultValue !== null) {
          // {&NAME=default}: emit default literal when NAME is undefined.
          builder.emit(d.defaultValue, {
            file: abs,
            inStart: cursor,
            inEnd: d.end,
            origin: "literal",
          });
        } else {
          diagnostics.push({
            severity: "warn",
            message: `{&${d.name}} referenced but undefined`,
            file: abs,
            offset: cursor,
          });
        }
        cursor = d.end;
        continue;
      }
      if (d.kind === "include") {
        const includeAbs = resolveInclude(d.file, propath, path.dirname(abs));
        const argsParsed = tokenizeArgs(d.argsRaw, d.argsOffset);
        const taggedPos = argsParsed.positional.map((a) => ({ ...a, sourceFile: abs }));
        const taggedNamed = new Map();
        for (const [k, v] of argsParsed.named) {
          taggedNamed.set(k, { ...v, sourceFile: abs });
        }
        if (!includeAbs) {
          diagnostics.push({
            severity: "warn",
            message: `include not found: ${d.file} (propath=${propath.length} entries)`,
            file: abs,
            offset: cursor,
          });
          builder.emit(`/* MISSING-INCLUDE: ${d.file} */`, {
            file: abs,
            inStart: cursor,
            inEnd: d.end,
            origin: "synthesized",
          });
        } else {
          builder.emit("", {
            file: abs,
            inStart: cursor,
            inEnd: d.end,
            origin: "include_callsite",
            via: { file: includeAbs, inStart: 0, inEnd: 0 },
          });
          expandFile(includeAbs, taggedPos, taggedNamed, [...stack, abs]);
        }
        cursor = d.end;
        continue;
      }
    }
    if (ifStack.length > 0) {
      diagnostics.push({
        severity: "warn",
        message: `unclosed &IF (${ifStack.length} open) at end of ${abs}`,
        file: abs,
      });
    }
  }

  expandFile(entrypoint, [], new Map(), []);

  return {
    virtualSource: builder.source,
    sourceMap: { segments: builder.segments },
    diagnostics,
    filesSeen: [...filesSeen],
  };
}

// === Sourcemap lookup ===

function segmentAt(sourceMap, outOffset) {
  const segs = sourceMap.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid];
    if (outOffset < s.outStart) hi = mid - 1;
    else if (outOffset >= s.outEnd) lo = mid + 1;
    else return s;
  }
  return null;
}

module.exports = {
  expand,
  segmentAt,
  // Exposed for unit tests:
  _tokenizeArgs: tokenizeArgs,
  _scanBraceDirective: scanBraceDirective,
  _scanAmpDirective: scanAmpDirective,
  _findNextDirective: findNextDirective,
  _resolveInclude: resolveInclude,
};
