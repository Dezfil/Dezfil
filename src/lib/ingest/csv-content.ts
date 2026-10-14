import { createReadStream } from "node:fs";
import { ApiError } from "@/lib/api/errors";

/** The reader synthesizes a column for empty input. Check before either
 * automatic recognition or a saved geometry choice consumes the file,
 * while preserving header-only tables and their column names. */
export async function requireCsvContent(sourcePath: string): Promise<void> {
  try {
    for await (const chunk of createReadStream(sourcePath, { encoding: "utf8" })) {
      if (/\S/.test(chunk)) return;
    }
    throw new Error("The CSV contains no header or data.");
  } catch (error) {
    throw new ApiError(
      "malformed_file",
      `The file could not be read as csv: ${error instanceof Error ? error.message : "unknown parse error"}`,
      422,
    );
  }
}
