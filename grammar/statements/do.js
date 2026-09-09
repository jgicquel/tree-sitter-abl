export default ({ kw }) => ({
  do_statement: ($) => seq($.__do_statement_prefix, $._terminator),

  // Some projects have includes that expand to an unclosed "DO ... :" — the
  // block is only closed by the file that invokes the include, with a bare
  // END. There is no way to know that from the grammar alone without reading
  // the include, so which paths do this is configured per project (see
  // TREE_SITTER_ABL_INCLUDE_DO_OPENERS in AGENTS.md and src/scanner.c),
  // rather than assumed. A pure grammar-level ambiguity here (any include
  // could be this DO's opener, only a later END confirms it) forced GLR
  // conflicts across every other place an include can appear (expressions,
  // class members, CASE OTHERWISE...), so disambiguation happens in the
  // external scanner instead: it recognizes a configured include path by
  // name and emits a zero-width marker before the ordinary include grammar
  // takes over, deterministically committing to this alternative with no
  // grammar-level ambiguity at all.
  implicit_do_statement: ($) =>
    seq(
      $._include_do_opener_marker,
      $.include_file_reference,
      // deopt: recurse
      repeat($._statement),
      $._end_keyword,
      $._terminator,
    ),

  __do_statement_prefix: ($) => seq(optional($._label), $.__do_body, $._end_keyword),

  // Widening the FOR branch counter makes record-phrase ambiguities global.
  __do_body: ($) =>
    seq(
      kw("DO"),
      choice(
        seq(alias($._for_phrase, $.for_phrase), optional($._selection_after_for), $.__do_body_tail),
        seq($._selection_after_for, $.__do_body_tail),
        choice(
          seq(
            alias(kw("TRANSACTION", { offset: 5 }), $.transaction),
            optional($.__do_body_after_first_transaction_wide),
          ),
          $.__do_body_after_first_transaction_wide,
        ),
      ),
    ),
  __do_body_after_first_transaction_wide: ($) =>
    choice(
      seq($.__do_condition_or_loop_phrase_wide, optional($.__do_body_after_condition_or_loop)),
      $.__do_block_tail,
    ),
  __do_condition_or_loop_phrase_wide: ($) =>
    choice(seq($.__do_while_phrase, optional($.__do_loop_phrase)), $.__do_loop_phrase),
  __do_body_tail: ($) =>
    choice(
      seq(
        alias(kw("TRANSACTION", { offset: 5 }), $.transaction),
        optional($.__do_body_after_first_transaction),
      ),
      $.__do_body_after_first_transaction,
    ),
  __do_body_after_first_transaction: ($) =>
    choice(
      seq($.__do_condition_or_loop_phrase, optional($.__do_body_after_condition_or_loop)),
      $.__do_block_tail,
    ),
  __do_body_after_condition_or_loop: ($) =>
    choice(
      seq(alias(kw("TRANSACTION", { offset: 5 }), $.transaction), optional($.__do_block_tail)),
      seq(alias($.__do_while_phrase, $.while_phrase), optional($.__do_block_tail)),
      $.__do_block_tail,
    ),
  __do_block_tail: ($) =>
    choice(
      seq(
        $._block_options,
        optional(alias(kw("TRANSACTION", { offset: 5 }), $.transaction)),
        $.body,
      ),
      $.body,
    ),

  body: ($) =>
    prec.right(
      seq(
        choice(alias($._colon, ":"), $._terminator_dot),
        // deopt: recurse
        repeat($._statement),
      ),
    ),
  __do_condition_or_loop_phrase: ($) =>
    choice(seq($.__do_while_phrase, optional($._loop_phrase)), $._loop_phrase),
  __do_loop_phrase: ($) =>
    seq(
      field(
        "variable",
        choice($.identifier, $.qualified_name, $.array_access, $.macro_concatenated_name),
      ),
      $._loop_phrase_tail,
    ),
  __do_while_phrase: ($) => seq(kw("WHILE"), field("condition", $._expression)),
});
