module.exports = ({ kw }) => ({
  create_widget_statement: ($) =>
    prec.right(seq(kw("CREATE"), $.__create_widget_body, $._terminator)),
  __create_widget_body: ($) =>
    seq(
      choice(
        kw("BUTTON"),
        kw("BROWSE"),
        kw("COMBO-BOX"),
        kw("CONTROL-FRAME"),
        kw("DIALOG-BOX"),
        kw("EDITOR"),
        kw("FILL-IN"),
        kw("FRAME"),
        kw("IMAGE"),
        kw("MENU"),
        kw("MENU-ITEM"),
        kw("RADIO-SET"),
        kw("RECTANGLE"),
        kw("SELECTION-LIST"),
        kw("SLIDER"),
        kw("SUB-MENU"),
        kw("TEXT"),
        kw("TOGGLE-BOX"),
        kw("WINDOW"),
        seq(kw("VALUE"), "(", field("widget_type", $._expression), ")"),
      ),
      optional($.__create_widget_tail),
    ),
  __create_widget_tail: ($) =>
    choice(
      seq($.__create_widget_handle, optional($.__create_widget_assign_triggers_tail)),
      $.__create_widget_assign_triggers_tail,
    ),
  __create_widget_assign_triggers_tail: ($) =>
    choice(seq($.assign_phrase, optional($.__create_widget_triggers)), $.__create_widget_triggers),
  __create_widget_handle: ($) =>
    seq(
      field("handle", $._identifier_or_array_access),
      optional($._in_widget_pool),
      optional(alias(kw("NO-ERROR"), $.no_error)),
    ),

  __create_widget_triggers: ($) =>
    seq(
      kw("TRIGGERS"),
      alias($._colon, ":"),
      repeat1($.__create_widget_trigger_definition),
      kw("END"),
      optional(kw("TRIGGERS")),
    ),

  __create_widget_trigger_definition: ($) =>
    seq(
      kw("ON"),
      field("event", $.__create_widget_event_list),
      choice($.do_statement, $.__create_widget_persistent_trigger),
    ),
  __create_widget_event_list: ($) => seq($._events, repeat(seq(",", $._events))),
  __create_widget_persistent_trigger: ($) =>
    seq(
      kw("PERSISTENT"),
      kw("RUN"),
      field("procedure", $.identifier),
      optional(seq(kw("IN"), field("handle", $.identifier))),
      optional(seq("(", field("parameters", $._expressions), ")")),
      $._terminator_dot,
    ),
});
