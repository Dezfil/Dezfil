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

export const MCP_UPLOAD_BODY_GUIDANCE = "MCP accepts at most 16,777,216 bytes for the entire JSON envelope, including base64. The raw file must be below 12 MiB, reduced by envelope and metadata overhead and by the configured upload cap. For canonical base64, subtract the serialized empty-content envelope bytes from 16,777,216, round down to whole groups of four, and allow three file bytes per group.";
