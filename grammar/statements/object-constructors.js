module.exports = ({ kw }) => ({
  dynamic_new_statement: ($) =>
    seq(
      field("target", $._assignable),
      "=",
      kw("DYNAMIC-NEW"),
      field("class", $._expression),
      $.arguments,
      $._no_error_terminator,
    ),
});
