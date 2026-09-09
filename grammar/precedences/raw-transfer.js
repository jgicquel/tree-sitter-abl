// References: RAW-TRANSFER statement.
export default ($) => [
  // Purpose: consume RAW-TRANSFER BUFFER markers before considering a handle prefix.
  // Example: RAW-TRANSFER FIELD source TO BUFFER target.
  [$.__raw_transfer_prefix, $.__object_access_handle_type],
  // Purpose: BUFFER is usable as a plain identifier (not reserved), but keep
  // the RAW-TRANSFER BUFFER marker reading first wherever both are live.
  [$.__raw_transfer_prefix, $._identifier_or_qualified_name],
];
