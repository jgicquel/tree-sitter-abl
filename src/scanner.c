#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS // MSVC/clang-cl: getenv() is fine for a read-only config lookup
#endif

#include <tree_sitter/parser.h>
#include <wctype.h>
#include <stdlib.h>
#include <string.h>

enum TokenType {
  NAMEDOT,
  NAMECOLON,
  NAMEDOUBLECOLON,
  NAMEPLUS,
  COLON,
  TERMINATOR_DOT,
  STRING_LITERAL,
  BLOCK_COMMENT,
  INCLUDE_DO_OPENER_MARKER,
  INCLUDE_CLASS_OPENER_MARKER,
  MACRO_STATEMENT
};

// Case-insensitive suffix match, so a configured "foo/bar.i" matches
// regardless of how deep the leading directory path goes, but a
// differently-located include of the same base name does not.
static bool ends_with_ci(const char *text, int text_len, const char *suffix) {
  int suffix_len = 0;
  while (suffix[suffix_len]) suffix_len++;
  if (text_len < suffix_len) return false;

  const char *start = text + (text_len - suffix_len);
  for (int i = 0; i < suffix_len; i++) {
    char a = start[i];
    char b = suffix[i];
    if (a >= 'A' && a <= 'Z') a += 'a' - 'A';
    if (b >= 'A' && b <= 'Z') b += 'a' - 'A';
    if (a != b) return false;
  }
  return true;
}

typedef struct {
  char **items;
  int count;
} StringList;

// Splits a ';'-separated environment variable value into trimmed,
// heap-allocated entries. An unset or empty variable yields an empty list.
static StringList parse_string_list(const char *env_value) {
  StringList list = {0};
  if (!env_value || !*env_value) return list;

  int capacity = 4;
  list.items = malloc(sizeof(char *) * (size_t)capacity);

  const char *start = env_value;
  while (*start) {
    const char *end = strchr(start, ';');
    int len = end ? (int)(end - start) : (int)strlen(start);

    while (len > 0 && (*start == ' ' || *start == '\t')) { start++; len--; }
    while (len > 0 && (start[len - 1] == ' ' || start[len - 1] == '\t')) len--;

    if (len > 0) {
      if (list.count == capacity) {
        capacity *= 2;
        list.items = realloc(list.items, sizeof(char *) * (size_t)capacity);
      }
      char *item = malloc((size_t)len + 1);
      memcpy(item, start, (size_t)len);
      item[len] = '\0';
      list.items[list.count++] = item;
    }

    if (!end) break;
    start = end + 1;
  }

  return list;
}

static void free_string_list(StringList *list) {
  for (int i = 0; i < list->count; i++) free(list->items[i]);
  free(list->items);
  list->items = NULL;
  list->count = 0;
}

typedef struct {
  // Include paths (matched by case-insensitive suffix) that this codebase
  // knows expand to an unclosed DO/CLASS the invoking file itself closes.
  // There is no way to know that from the grammar alone without reading the
  // include, so it is configured per project rather than assumed: set
  // TREE_SITTER_ABL_INCLUDE_DO_OPENERS / TREE_SITTER_ABL_INCLUDE_CLASS_OPENERS
  // to a ';'-separated list before parsing (see AGENTS.md). Unset means
  // neither list opens anything, and every include parses as a plain,
  // self-contained reference.
  StringList do_openers;
  StringList class_openers;
} ScannerState;

void *tree_sitter_abl_external_scanner_create() {
  ScannerState *state = malloc(sizeof(ScannerState));
  state->do_openers = parse_string_list(getenv("TREE_SITTER_ABL_INCLUDE_DO_OPENERS"));
  state->class_openers = parse_string_list(getenv("TREE_SITTER_ABL_INCLUDE_CLASS_OPENERS"));
  return state;
}

void tree_sitter_abl_external_scanner_destroy(void *payload) {
  ScannerState *state = (ScannerState *)payload;
  if (!state) return;
  free_string_list(&state->do_openers);
  free_string_list(&state->class_openers);
  free(state);
}

unsigned int tree_sitter_abl_external_scanner_serialize(
  void *payload,
  char *buffer
) {
  (void)payload;
  (void)buffer;
  return 0u;
}

void tree_sitter_abl_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned int length
) {
  (void)payload;
  (void)buffer;
  (void)length;
}

bool tree_sitter_abl_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid_symbols
) {
  ScannerState *state = (ScannerState *)payload;

  // A configured include path (see ScannerState above) expands to an
  // unclosed DO/CLASS that the invoking file closes with a bare END. There
  // is no way to know that from the grammar alone without reading the
  // include, so this is decided by name here and committed to a zero-width
  // marker token ahead of the ordinary include grammar, deterministically,
  // rather than leaving it as a grammar-level ambiguity (see grammar/statements
  // do.js and class.js for why: it forced GLR conflicts across every other
  // place an include can appear).
  // Both checks below start from the same '{' and cannot be tried one after
  // the other within a single scan() call (advance() is not undoable short
  // of returning false, which discards everything from this call, not just
  // the failed sub-attempt) — so dispatch once, up front, on the character
  // after '{': a {&NAME} macro statement is the only one of the two that can
  // start with '&' there, a do/class-opening include path never does.
  bool wants_include_marker =
      valid_symbols[INCLUDE_DO_OPENER_MARKER] || valid_symbols[INCLUDE_CLASS_OPENER_MARKER];

  if (wants_include_marker || valid_symbols[MACRO_STATEMENT]) {
    // Extras (whitespace) are not yet skipped when the external scanner runs;
    // skip them as extras (advance(..., true)) before looking for '{', or a
    // merely-indented include/macro (the common case, nested in a method
    // body) would never be recognized.
    while (!lexer->eof(lexer) && iswspace(lexer->lookahead)) {
      lexer->advance(lexer, true);
    }
  }

  if ((wants_include_marker || valid_symbols[MACRO_STATEMENT]) && lexer->lookahead == '{') {
    lexer->mark_end(lexer); // freeze a zero-width end right before '{', for the include markers
    lexer->advance(lexer, false); // consume '{' for lookahead only, past the frozen end

    // A configured include path (see ScannerState above) expands to an
    // unclosed DO/CLASS that the invoking file closes with a bare END.
    // There is no way to know that from the grammar alone without reading
    // the include, so recognize a configured path by name here and commit
    // to a zero-width marker token ahead of the ordinary include grammar,
    // deterministically, rather than leaving it as a grammar-level
    // ambiguity (see grammar/statements do.js and class.js for why: it
    // forced GLR conflicts across every other place an include can appear).
    if (wants_include_marker && lexer->lookahead != '&') {
      char buf[128];
      int len = 0;

      while (!lexer->eof(lexer) && lexer->lookahead != '}' && !iswspace(lexer->lookahead)) {
        if (len < (int)sizeof(buf) - 1) buf[len++] = (char)lexer->lookahead;
        lexer->advance(lexer, false);
      }

      if (valid_symbols[INCLUDE_DO_OPENER_MARKER]) {
        for (int i = 0; i < state->do_openers.count; i++) {
          if (ends_with_ci(buf, len, state->do_openers.items[i])) {
            lexer->result_symbol = INCLUDE_DO_OPENER_MARKER;
            return true;
          }
        }
      }

      if (valid_symbols[INCLUDE_CLASS_OPENER_MARKER]) {
        for (int i = 0; i < state->class_openers.count; i++) {
          if (ends_with_ci(buf, len, state->class_openers.items[i])) {
            lexer->result_symbol = INCLUDE_CLASS_OPENER_MARKER;
            return true;
          }
        }
      }

      return false;
    }

    // A {&NAME} macro alone on its line (a "pragma", e.g. prolint-nowarn
    // annotations) is its own statement/class member, distinct from the same
    // {&NAME} spelling used inline as a preprocessor_name (an accessor
    // modifier, an EXTENT size, ...). Only what follows the closing '}'
    // tells them apart, and a regex token cannot look ahead without
    // consuming a trailing "// comment" into itself (losing it as its own
    // comment node), so it is decided here instead: peek past '}', and
    // commit only if nothing but optional whitespace and an optional
    // "// comment" precede the newline.
    if (valid_symbols[MACRO_STATEMENT] && lexer->lookahead == '&') {
      lexer->advance(lexer, false); // consume '&'
      bool saw_body = false;

      while (!lexer->eof(lexer) && lexer->lookahead != '}' && lexer->lookahead != '\r' &&
             lexer->lookahead != '\n') {
        saw_body = true;
        lexer->advance(lexer, false);
      }

      if (saw_body && lexer->lookahead == '}') {
        lexer->advance(lexer, false); // consume '}'
        lexer->mark_end(lexer); // the token itself is just "{&NAME}"

        while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
          lexer->advance(lexer, false);
        }

        if (lexer->lookahead == '/') {
          lexer->advance(lexer, false);
          if (lexer->lookahead == '/') {
            while (!lexer->eof(lexer) && lexer->lookahead != '\r' && lexer->lookahead != '\n') {
              lexer->advance(lexer, false);
            }
          } else {
            return false; // a single '/' is not a comment, not this pattern
          }
        }

        if (lexer->lookahead == '\r') lexer->advance(lexer, false);
        if (lexer->lookahead == '\n') {
          lexer->result_symbol = MACRO_STATEMENT;
          return true;
        }
      }
    }

    // No match: the peeking above must not leak into the checks below, which
    // assume they are looking at the original, unadvanced lexer position.
    return false;
  }

  if (valid_symbols[NAMEDOT] || valid_symbols[NAMECOLON] || valid_symbols[NAMEDOUBLECOLON] ||
      valid_symbols[NAMEPLUS] || valid_symbols[COLON] || valid_symbols[TERMINATOR_DOT]) {
    if (lexer->lookahead == '.') {
      lexer->advance(lexer, false);
      lexer->mark_end(lexer);

      if ((iswalpha(lexer->lookahead) || lexer->lookahead == '_') && valid_symbols[NAMEDOT]) {
        lexer->result_symbol = NAMEDOT;
        return true;
      }

      if (valid_symbols[TERMINATOR_DOT]) {
        lexer->result_symbol = TERMINATOR_DOT;
        return true;
      }
    }

    if (lexer->lookahead == '+' && valid_symbols[NAMEPLUS]) {
      lexer->advance(lexer, false);
      lexer->mark_end(lexer);

      if (iswalpha(lexer->lookahead) || lexer->lookahead == '_') {
        lexer->result_symbol = NAMEPLUS;
        return true;
      }
    }

    if (lexer->lookahead == ':') {
      lexer->advance(lexer, false);
      lexer->mark_end(lexer);

      if (lexer->lookahead == ':' && valid_symbols[NAMEDOUBLECOLON]) {
        lexer->advance(lexer, false);
        if (iswalpha(lexer->lookahead) || lexer->lookahead == '_') {
          lexer->mark_end(lexer);
          lexer->result_symbol = NAMEDOUBLECOLON;
          return true;
        }
      }

      if ((iswalpha(lexer->lookahead) || lexer->lookahead == '_') && valid_symbols[NAMECOLON]) {
        lexer->result_symbol = NAMECOLON;
        return true;
      }

      if (valid_symbols[COLON]) {
        lexer->result_symbol = COLON;
        return true;
      }
    }

    if (valid_symbols[NAMECOLON] || valid_symbols[NAMEDOUBLECOLON] || valid_symbols[COLON]) {
      while (!lexer->eof(lexer) && iswspace(lexer->lookahead)) {
        lexer->advance(lexer, true);
      }

      if (lexer->lookahead == ':') {
        lexer->advance(lexer, false);
        lexer->mark_end(lexer);

        if (lexer->lookahead == ':' && valid_symbols[NAMEDOUBLECOLON]) {
          lexer->advance(lexer, false);
          if (iswalpha(lexer->lookahead) || lexer->lookahead == '_') {
            lexer->mark_end(lexer);
            lexer->result_symbol = NAMEDOUBLECOLON;
            return true;
          }
        }

        if ((iswalpha(lexer->lookahead) || lexer->lookahead == '_') &&
            valid_symbols[NAMECOLON]) {
          lexer->result_symbol = NAMECOLON;
          return true;
        }

        if (valid_symbols[COLON]) {
          lexer->result_symbol = COLON;
          return true;
        }
      }
    }

    if (valid_symbols[TERMINATOR_DOT] || valid_symbols[NAMEDOT]) {
      while (!lexer->eof(lexer) && iswspace(lexer->lookahead)) {
        lexer->advance(lexer, true);
      }

      if (lexer->lookahead == '.') {
        lexer->advance(lexer, false);
        lexer->mark_end(lexer);
        if ((iswalpha(lexer->lookahead) || lexer->lookahead == '_') &&
            valid_symbols[NAMEDOT]) {
          lexer->result_symbol = NAMEDOT;
          return true;
        }
        if (valid_symbols[TERMINATOR_DOT]) {
          lexer->result_symbol = TERMINATOR_DOT;
          return true;
        }
      }
    }
  }

  if (valid_symbols[STRING_LITERAL] &&
      (lexer->lookahead == '"' || lexer->lookahead == '\'')) {
    char start = lexer->lookahead;
    lexer->advance(lexer, false);

    while (!lexer->eof(lexer)) {
      if (lexer->lookahead == start) {
        lexer->advance(lexer, false);
        if (lexer->lookahead == start) {
          lexer->advance(lexer, false);
          continue;
        }
        // The closing quote ends the string, but ABL allows a case-marker
        // suffix right after it. Consume it here so the ':' cannot be taken
        // for a block-opening colon, as in
        //   FOR EACH cust WHERE cust.id = "X":U NO-LOCK:
        // Accepted shapes: :[RLCT]U?[0-9]* | :U[0-9]* | :[0-9]+
        lexer->mark_end(lexer);
        if (lexer->lookahead == ':') {
          lexer->advance(lexer, false);
          int marker = lexer->lookahead;
          bool extended = false;
          if (marker == 'R' || marker == 'L' || marker == 'C' || marker == 'T' ||
              marker == 'r' || marker == 'l' || marker == 'c' || marker == 't') {
            lexer->advance(lexer, false);
            if (lexer->lookahead == 'U' || lexer->lookahead == 'u') {
              lexer->advance(lexer, false);
            }
            while (iswdigit(lexer->lookahead)) lexer->advance(lexer, false);
            extended = true;
          } else if (marker == 'U' || marker == 'u') {
            lexer->advance(lexer, false);
            while (iswdigit(lexer->lookahead)) lexer->advance(lexer, false);
            extended = true;
          } else if (iswdigit(lexer->lookahead)) {
            while (iswdigit(lexer->lookahead)) lexer->advance(lexer, false);
            extended = true;
          }
          if (extended) lexer->mark_end(lexer);
        }
        lexer->result_symbol = STRING_LITERAL;
        return true;
      }

      if (lexer->lookahead == '~') {
        lexer->advance(lexer, false);
        if (!lexer->eof(lexer)) {
          lexer->advance(lexer, false);
        }
      } else {
        lexer->advance(lexer, false);
      }
    }
  }

  if (valid_symbols[BLOCK_COMMENT]) {
    while (!lexer->eof(lexer) && iswspace(lexer->lookahead)) {
      lexer->advance(lexer, true);
    }

    if (lexer->lookahead != '/') {
      return false;
    }
    lexer->advance(lexer, false);
    if (lexer->lookahead != '*') {
      return false;
    }
    lexer->advance(lexer, false);

    unsigned int depth = 1;
    while (!lexer->eof(lexer)) {
      if (lexer->lookahead == '/') {
        lexer->advance(lexer, false);
        if (lexer->lookahead == '*') {
          lexer->advance(lexer, false);
          depth++;
          continue;
        }
        continue;
      }

      if (lexer->lookahead == '*') {
        lexer->advance(lexer, false);
        if (lexer->lookahead == '/') {
          lexer->advance(lexer, false);
          depth--;
          if (depth == 0) {
            lexer->mark_end(lexer);
            lexer->result_symbol = BLOCK_COMMENT;
            return true;
          }
        }
        continue;
      }

      lexer->advance(lexer, false);
    }
  }

  return false;
}
