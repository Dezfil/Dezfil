// The assistant's model in the picture run: a scripted stand-in for a model
// provider, served on loopback by the picture script itself, so the
// assistant scenes show the pane at work with no provider key and no
// request off the run. The instance is started with its OpenAI adapter
// pointed here and a key that belongs to no provider, as the browser suite
// does with its own scripted model.
//
// Only the model's part is scripted: what it says and which actions it asks
// for. The instance runs everything else for real, on the scratch data: the
// grounding, the actions, their confirmation and their record. The model
// answers each request from the words of the person's message and the
// actions answered so far, never from the order of requests, so both takes
// of a scene get the same replies. A request it has no answer for is
// refused, and the run names it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

/** The key the instance is given: it opens nothing anywhere. */
export const SCRIPTED_KEY = "docs-pictures-scripted-model";

/** How the instance reaches the scripted model and what it is told. The
 * automatic map check is off: with it on, a turn that changes the map asks
 * the server to draw it, and the picture run's server draws no maps. */
export function assistantEnvironment(url) {
  return {
    DEZFIL_AI_PROVIDER: "openai",
    OPENAI_API_KEY: SCRIPTED_KEY,
    OPENAI_BASE_URL: `${url}/v1`,
    DEZFIL_ASSISTANT_AUTO_CHECK: "off",
  };
}

/** The messages the assistant scenes type, as "The assistant" gives them. */
export const ASSISTANT_MESSAGES = {
  color: "Color the cities by population in five classes",
  count: "Count the cities in each country, largest first",
  remove: "Delete the world_cities dataset",
};

/** The query the scripted model proposes on the SQL page. No two countries
 * tie on both keys, so the order is total. */
export const PROPOSED_QUERY = [
  "SELECT country, count(*) AS cities",
  "FROM world_cities",
  "GROUP BY country",
  "ORDER BY cities DESC, country;",
].join("\n");

const GROUNDING_PREFIX = "Instance grounding (data):\n";

const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * What a request to the model carries, read as the scripted model needs it:
 * the person's message (the last of their own turns), the instance's
 * grounding, and the actions the model asked for since that message, each
 * by its name with its arguments and, once it ran, the instance's answer.
 */
export function readRequest(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  let grounding = null;
  let at = -1;
  input.forEach((item, index) => {
    if (item?.role !== "user" || typeof item.content !== "string") return;
    if (item.content.startsWith(GROUNDING_PREFIX)) grounding = parsed(item.content.slice(GROUNDING_PREFIX.length));
    else at = index;
  });
  const message = at >= 0 ? input[at].content : null;
  const calls = {};
  const byId = new Map();
  for (const item of input.slice(at + 1)) {
    if (item?.type === "function_call") {
      const call = { args: parsed(item.arguments) ?? {}, output: undefined };
      calls[item.name] = call;
      byId.set(item.call_id, call);
    } else if (item?.type === "function_call_output" && byId.has(item.call_id)) {
      byId.get(item.call_id).output = typeof item.output === "string" ? parsed(item.output) : null;
    }
  }
  return { message, grounding, calls };
}

/** The layer the person selected on the map, as the grounding names it. */
function selectedLayer(grounding) {
  const id = grounding?.context?.selectedLayerId;
  assert.ok(id, "The message was sent with no layer selected.");
  const layer = grounding?.map?.layers?.items?.find((item) => item.id === id);
  assert.ok(layer?.style, "The grounding does not carry the selected layer's style.");
  return layer;
}

/** An action's answer, refused when the instance refused it. */
function answered(call, name) {
  assert.ok(call.output && !call.output.error, `${name} answered ${JSON.stringify(call.output)}.`);
  return call.output;
}

/**
 * The scripted model's reply to a request: text, actions to run, or both.
 * Each message is answered in steps, the next step decided by the actions
 * already answered.
 */
export function scriptedReply(body) {
  const { message, grounding, calls } = readRequest(body);
  if (message === ASSISTANT_MESSAGES.color) {
    const layer = selectedLayer(grounding);
    if (!calls.compute_fill) {
      return { calls: [{ name: "compute_fill", args: { id: layer.id, attribute: "population", method: "quantile", classes: 5 } }] };
    }
    const fill = answered(calls.compute_fill, "compute_fill");
    if (!calls.update_layer) return { calls: [{ name: "update_layer", args: { id: layer.id, style: { ...layer.style, fill } } }] };
    answered(calls.update_layer, "update_layer");
    return { text: "The cities are colored by population in five classes, each holding about the same number of cities. The legend lists the classes with their ranges." };
  }
  if (message === ASSISTANT_MESSAGES.count) {
    return { text: `This counts the cities of each country and puts the country with the most first:\n\n\`\`\`sql\n${PROPOSED_QUERY}\n\`\`\`` };
  }
  if (message === ASSISTANT_MESSAGES.remove && !calls.delete_table) {
    return { calls: [{ name: "delete_table", args: { name: "world_cities" } }] };
  }
  throw new Error(`The scripted model has no reply to ${JSON.stringify(message)} after ${JSON.stringify(Object.keys(calls))}.`);
}

/** A reply as the provider's stream of events: the text, then the
 * completed response with the text and the actions. */
export function replyEvents(reply) {
  const output = [];
  if (reply.text) output.push({ type: "message", id: randomUUID(), role: "assistant", status: "completed", content: [{ type: "output_text", text: reply.text, annotations: [] }] });
  for (const call of reply.calls ?? []) output.push({ type: "function_call", id: randomUUID(), call_id: randomUUID(), name: call.name, arguments: JSON.stringify(call.args), status: "completed" });
  const events = [];
  if (reply.text) events.push({ type: "response.output_text.delta", delta: reply.text });
  events.push({ type: "response.completed", response: { id: randomUUID(), model: "scripted", status: "completed", output } });
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/**
 * Serve the scripted model on loopback, on a port the system hands out.
 * Returns its address, its host as the server's request observer writes
 * it, what it could not answer, and how to stop it.
 */
export async function startScriptedModel() {
  const problems = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      problems.push(`${request.method} ${request.url}`);
      response.writeHead(404).end();
      return;
    }
    let text = "";
    for await (const chunk of request) text += chunk;
    let reply;
    try {
      reply = scriptedReply(parsed(text));
    } catch (error) {
      problems.push(error.message);
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: error.message } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(replyEvents(reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    problems,
    async stop() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
