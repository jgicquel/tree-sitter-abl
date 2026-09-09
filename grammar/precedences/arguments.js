// References: Parameter passing syntax.
export default ($) => [
  // Purpose: treat BUFFER in argument position as a parameter marker before a handle prefix.
  // Example: RUN p (BUFFER b:HANDLE).
  [$.__argument_body, $.__object_access_handle_type],
  // Purpose: BUFFER/TABLE-HANDLE are usable as plain identifiers (not
  // reserved), but keep the TABLE/BUFFER/... parameter-marker reading first
  // wherever both are still live (e.g. before a name that continues it).
  // Example: RUN p (BUFFER b:HANDLE) vs. VALID-OBJECT(Buffer).
  [$.__argument_body, $._identifier_or_qualified_name],
];
