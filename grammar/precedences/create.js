// References: CREATE BUFFER statement.
export default ($) => [
  // Purpose: keep CREATE BUFFER statements from being interpreted as generic expression starts.
  // Example: CREATE BUFFER bh FOR TABLE tt.
  [$.__create_buffer, $.__object_access_handle_type],
  // Purpose: keep CREATE TEMP-TABLE statement from being interpreted as generic expression starts.
  // Example: CREATE TEMP-TABLE tt.
  [$.__create_temp_table_body, $.__object_access_handle_type],
  // Purpose: prefer CREATE BUFFER target over bare identifier.
  // Example: CREATE BUFFER hBuf FOR TABLE Customer IN WIDGET-POOL wp.
  [$.__create_buffer_target, $._identifier_or_qualified_name],
  // Purpose: BUFFER is usable as a plain identifier (not reserved), but keep
  // the handle-type qualifier reading first wherever both are still live.
  // Example: CREATE BUFFER Buffer FOR TABLE tt IN Buffer:SomePool.
  [$.__object_access_handle_type, $._identifier_or_qualified_name],
  // Purpose: CREATE BUFFER ... FOR TABLE stays the dedicated statement form
  // even though BUFFER now also parses as a plain identifier elsewhere.
  [$.__create_buffer, $._identifier_or_qualified_name],
  // Purpose: keep CREATE handle forms ahead of DATA-SOURCE handle and DATASET expression prefixes.
  // Example: CREATE DATA-SOURCE hSource; CREATE DATASET hDataset.
  // Reference: CREATE statement handle forms.
  [$.__create_handle_with_pool_body, $.__object_access_handle_type, $.dataset_reference],
];
