import type { APIError } from "openai";
import { apiFailureSentence } from "./api-failure";

type Worded = Pick<APIError, "status" | "code" | "type" | "message">;

/**
 * What an API failure names itself by. An HTTP response carries a status;
 * an error the Responses stream delivers inside a 200 carries none, and the
 * SDK hands it on with the body's own `code` and `type` instead. Reading
 * the absent status as the network told the person their connection had
 * failed when their account had refused, so the error names itself by what
 * it has: the status, else the code, else the type. With none of the three
 * the message stands alone, without an empty parenthesis.
 */
export function openaiFailureSentence(error: Worded): string {
  return apiFailureSentence("OpenAI", [error.status, error.code, error.type], error.message);
}
