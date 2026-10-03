/**
 * Outer wire-byte admission bound for the two workflow JSON readers.
 *
 * A typical maximal layout spends about 2 MB on two position maps with 1,000
 * ASCII keys of 1,000 characters each, plus about 0.4 MB on 100 maximal note
 * texts and ordinary JSON/position overhead. The semantic bounds do not
 * impose a wire maximum, though: maximal astral keys written as paired
 * `\uXXXX` escapes alone can occupy about 24 MB, and note ids have no length
 * bound. The 16 MiB cap deliberately refuses those pathological shapes; this
 * outer byte bound complements rather than restates semantic bounds.
 */
export const WORKFLOW_JSON_BODY_MAX_BYTES = 16 * 1024 * 1024;

/** Authentication, account administration and anonymous selection envelopes. */
export const SMALL_JSON_BODY_MAX_BYTES = 65_536;

/** Maps, layers and other general JSON envelopes. */
export const LARGE_JSON_BODY_MAX_BYTES = 16_777_216;
