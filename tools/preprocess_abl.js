// Lightweight ABL preprocessor: substitutes the textual elements that ABL's
// real preprocessor would resolve before parsing — turning placeholder
// references (`{1}`, `{1}.field`, `{include.i args}`, `{&NAME args}`) into
// plain identifiers the grammar can handle, and stripping `&IF/&ELSEIF/&ENDIF`
// branches and `{&_proparse_*}` annotations that are not valid ABL syntax
// proper.
//
// This is NOT a faithful preprocessor — it does not evaluate `&IF` conditions
// or follow include resolution. It only normalizes the source to a form the
// grammar can accept, so the realworld harness can validate that the
// non-preprocessor portions of a file parse cleanly.
//
// Source: ported from
// `packages/openedge-code-analyzer/test-validation.js` in ia-dev-tools.
//
// Substitutions performed (order matters):
//   /\* nested *\/ comments  → outer-only (inner /* */ neutralized to spaces)
//   \r                       → ''
//   ^\s*&.*                  → ''         (drop preprocessor directive lines)
//   {&_proparse_…}           → ''
//   {N}.field                → __ppN_field
//   {N}                      → __ppN
//   {<file>.<ext> args}      → __INCL_<sanitized>
//   {&NAME args}             → __PP_NAME

// Replaces `&IF cond &THEN ... &ELSEIF ... &ELSE ... &ENDIF` by keeping
// only the FIRST branch's content. Other `&` directive lines (anything
// not part of an IF/ELSEIF/ELSE/THEN/ENDIF chain — e.g. &SCOPED-DEFINE,
// &GLOBAL-DEFINE, &MESSAGE, &ANALYZE-…, &UNDEFINE) are dropped wholesale.
//
// Why first-branch-only: stripping every `&` line individually leaves
// content from ALL branches in the source, which doubles up DO/END pairs
// and produces cascade errors. Keeping just the first branch preserves
// semantic balance most of the time without needing to evaluate the
// preprocessor condition.
function reduceAmpersandConditionals(source) {
  const lines = source.split("\n");
  const out = [];
  // Stack of {emitting: bool} per nested &IF. emitting=true means we're in
  // the first branch (before any &ELSEIF/&ELSE) and should keep content.
  const stack = [];
  const emittingHere = () => stack.every((s) => s.emitting);

  const startsWith = (line, kw) => new RegExp(`^\\s*${kw}\\b`, "i").test(line);
  // A `~` at end of line (optionally followed by whitespace) is ABL line
  // continuation for preprocessor directives like &Scoped-Define.
  const isContinued = (line) => /~\s*$/.test(line);

  // When stripping a `&` directive, also strip its continuation lines.
  let stripContinuation = false;

  for (const line of lines) {
    if (stripContinuation) {
      const wasContinued = isContinued(line);
      out.push("");
      stripContinuation = wasContinued;
      continue;
    }
    // The `&IF` keyword may appear with text both before (rare) and after.
    // For our purposes we treat `&IF` / `&ELSEIF` / `&ELSE` / `&ENDIF` as
    // line-level directives — they always start the line in real ABL code.
    if (startsWith(line, "&IF")) {
      stack.push({ emitting: emittingHere() });
      stripContinuation = isContinued(line);
      continue;
    }
    if (startsWith(line, "&ELSEIF") || startsWith(line, "&ELSE")) {
      if (stack.length > 0) stack[stack.length - 1].emitting = false;
      stripContinuation = isContinued(line);
      continue;
    }
    if (startsWith(line, "&ENDIF")) {
      if (stack.length > 0) stack.pop();
      stripContinuation = isContinued(line);
      continue;
    }
    if (/^\s*&/.test(line)) {
      // Other &-directive line (&SCOPED-DEFINE / &GLOBAL-DEFINE / &MESSAGE /
      // &ANALYZE-… / &UNDEFINE / &THEN-on-its-own / etc.) — drop it.
      stripContinuation = isContinued(line);
      continue;
    }
    if (emittingHere()) out.push(line);
    else out.push(""); // preserve line numbering for error reporting
  }
  return out.join("\n");
}

function normalizeNestedComments(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      out.push("/", "*");
      while (j < source.length && depth > 0) {
        if (source[j] === "/" && source[j + 1] === "*") {
          depth++;
          out.push("/", " ");
          j += 2;
        } else if (source[j] === "*" && source[j + 1] === "/") {
          depth--;
          if (depth === 0) out.push("*", "/");
          else out.push(" ", "/");
          j += 2;
        } else {
          out.push(source[j]);
          j++;
        }
      }
      i = j;
    } else {
      out.push(source[i]);
      i++;
    }
  }
  return out.join("");
}

// Each step is opt-out via { stepName: false } in opts. Defaults are
// driven by tools/audit_preprocess.js — only steps that empirically
// reduce parser errors on the curated realworld harness ship enabled.
// The others are kept in code for archival / opt-in via { stepName: true }.
//
// Defaults (audited 2026-05-10 against modern modular grammar):
//   nestedComments       OFF — corrupts comments containing `/*/ ` patterns;
//                              external scanner already counts depth.
//   crlf                 OFF — tree-sitter handles CRLF natively.
//   argRefQualified      OFF — argRefBare leaves `.field` for qualified_name
//                              to handle naturally (`__ppN.field` parses).
//   includeWithArgs      OFF — actively harmful: grammar has native
//                              include_statement / __include_arguments rules
//                              that produce richer AST than the substituted
//                              `__INCL_…` placeholder.
//   namedDefineWithArgs  OFF — grammar's preprocessor_name handles `{&NAME}`
//                              patterns; substitution is no-op for parsing.
//   ampersandLines       ON  — reduces `&IF/&ELSEIF/&ENDIF/&SCOPED-DEFINE`
//                              etc. by keeping only the first conditional
//                              branch. Stripping every branch leaves
//                              unbalanced DO/END pairs and cascade errors.
//   proparseAnnotation   ON  — strips `{&_proparse_*}` annotations that the
//                              grammar treats as include calls and fails on.
//   argRefBare           ON  — substitutes `{N}` → `__ppN` so the placeholder
//                              becomes a regular identifier; the grammar's
//                              argument_reference rule does not extend to
//                              qualified `{N}.field` access.
function preprocessABL(src, opts = {}) {
  const enabledByDefault = {
    nestedComments: false,
    crlf: false,
    argRefQualified: false,
    includeWithArgs: false,
    namedDefineWithArgs: false,
    ampersandLines: true,
    proparseAnnotation: true,
    argRefBare: true,
    classOpenerInclude: false,
    forEachOpenerInclude: false,
  };
  const enabled = (name) => (opts[name] !== undefined ? opts[name] : enabledByDefault[name]);

  let r = src;
  if (enabled("nestedComments")) r = normalizeNestedComments(r);
  if (enabled("crlf")) r = r.replace(/\r/g, "");
  if (enabled("ampersandLines")) r = reduceAmpersandConditionals(r);
  if (enabled("proparseAnnotation")) r = r.replace(/\{&_proparse_[^}]*\}/g, "");
  if (enabled("argRefQualified"))
    r = r.replace(/\{(\d+)\}\.([A-Za-z_][A-Za-z0-9_\-]*)/g, "__pp$1_$2");
  if (enabled("argRefBare")) r = r.replace(/\{(\d+)\}/g, "__pp$1");
  if (enabled("includeWithArgs")) {
    r = r.replace(
      /\{([A-Za-z][\w\-]*(?:[\/\\][\w\-]+)*\.(?:i|def|p|w|cls))\s+([^}]+)\}/g,
      (_m, file) => `__INCL_${file.replace(/[^A-Za-z0-9]/g, "_")}`,
    );
  }
  if (enabled("namedDefineWithArgs"))
    r = r.replace(/\{&([A-Za-z_][A-Za-z0-9_\-]*)\s+[^}]+\}/g, "__PP_$1");
  if (enabled("classOpenerInclude")) {
    // Some codebases use include files that emit a `CLASS Name:` opener.
    // Match such includes by name pattern (configurable via opts) and inject
    // the class header so downstream code parses inside a class scope. By
    // default no pattern is provided — set opts.classOpenerInclude to a
    // RegExp matching the include filename.
    const pattern = opts.classOpenerIncludePattern;
    if (pattern) {
      let injectedHeader = false;
      r = r.replace(pattern, (_m, className, implementsClause) => {
        injectedHeader = true;
        const impl = implementsClause ? implementsClause.replace(/\s+/g, " ").trimEnd() : "";
        return `CLASS ${className}${impl}:`;
      });
      if (injectedHeader && !/\bEND\s+CLASS\b/i.test(r)) {
        r = r + "\nEND CLASS.\n";
      }
    }
  }
  if (enabled("forEachOpenerInclude")) {
    // Some include files emit a `FOR EACH ...:` block opener that needs a
    // matching END.. Inject a synthetic opener so the matching END. closes
    // correctly. Configurable via opts.forEachOpenerIncludePattern.
    const pattern = opts.forEachOpenerIncludePattern;
    if (pattern) {
      r = r.replace(pattern, (_m, varName) => `FOR EACH __${varName}_iter TRANSACTION:`);
    }
  }
  return r.replace(/\s+$/, "");
}

module.exports = { preprocessABL, normalizeNestedComments };
