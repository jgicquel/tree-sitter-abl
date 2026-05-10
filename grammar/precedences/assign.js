// References: ASSIGN phrase.
module.exports = ($) => [
  // Purpose: treat FRAME as identifier in ASSIGN, not widget keyword.
  // Example: ASSIGN FRAME = WFRAME[...]:HANDLE.
  // The widget object_access form (`FRAME someName:HANDLE`) is much rarer
  // as an assignable target than `FRAME = expr`, so prefer the keyword
  // identifier path. The widget path is still reachable when nothing
  // immediately follows FRAME that fits an assign continuation.
  [$.__assign_keyword_identifier, $._widgets],
  [$.__assign_keyword_identifier, $.object_access],
  [$.__assign_keyword_identifier, $._object_access_widget],
  // Purpose: prefer record form in ASSIGN when EXCEPT is present.
  // Example: ASSIGN Customer EXCEPT Name.
  [$.__assign_record_body, $._assignable],
  // Purpose: treat identifier + '(' as a function call assignable.
  // Example: ASSIGN SomeFunc() = 1.
  [$.function_call, $._assignable],
  // Purpose: prefer ASSIGN statement over generic assignment.
  // Example: ASSIGN Customer EXCEPT Name.
  [$.assign_statement, $.assignment_statement],
];
