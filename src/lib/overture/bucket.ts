/**
 * Where Overture's public releases live. The pane's query display reads
 * these in the browser, so this module imports nothing: the release
 * listing that reaches the bucket over the network stays in releases.ts,
 * on the server.
 */

export const OVERTURE_BUCKET = "overturemaps-us-west-2";
export const OVERTURE_REGION = "us-west-2";
export const OVERTURE_S3_BASE = `s3://${OVERTURE_BUCKET}/release`;
