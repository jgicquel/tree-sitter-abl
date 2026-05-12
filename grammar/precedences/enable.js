// References: ENABLE statement.
module.exports = ($) => [
  // Purpose: allow full expressions inside enable items.
  // Example: ENABLE a - b.
  [$.__enable_item, $._primary_expression],
  // Purpose: prefer treating `name (` as a function call rather than a bare
  // enable item followed by another expression starting with `(`.
  // Example: ENABLE myFunc(arg).
  [$.function_call, $.__enable_item],
];
