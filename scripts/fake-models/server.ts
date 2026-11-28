import { randomUUID } from "node:crypto";

type Part = { type: string; text?: string; content?: unknown; is_error?: boolean };
type Message = { role: string; content: string | Part[] };
type Tool = { type?: string; name: string; description?: string; tools?: Tool[] };
type ResponseInput = Partial<Message> & { type?: string; output?: unknown; tools?: Tool[] };
type RequestBody = {
  model: string;
  stream?: boolean;
  messages?: Message[];
  input?: string | ResponseInput[];
  tools?: Tool[];
};

const id = (prefix: string) => prefix + "_" + randomUUID().replaceAll("-", "");
const text = (parts?: string | Part[]) => typeof parts === "string" ? parts : parts?.map(p => p.text ?? "").join(" ") ?? "";

function stream(write: (emit: (type: string, data: object) => void) => Promise<void> | void, onError: (error: unknown) => void) {
  let cancelled = false;
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const emit = (type: string, data: object) => {
        if (!cancelled) controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
      };
      try {
        await write(emit);
        if (!cancelled) controller.close();
      } catch (error) {
        onError(error);
        if (!cancelled) controller.error(error);
      }
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function anthropic(body: RequestBody, log: (data: object) => void) {
  const input = body.messages?.findLast(message => message.role === "user")?.content;
  const prompt = text(input);
  const result = Array.isArray(input) ? input.find(part => part.type === "tool_result") : undefined;
  const incoming = prompt.match(/<cross-session-message[^>]* from-name="([^"]+)"[^>]*>\s*([\s\S]*?)<\/cross-session-message>/);
  const peer = prompt.match(/FIXTURE_PEER(_DEFAULT)? (codex\([^\n)]+\))/);
  const reply = incoming?.[2].includes("FIXTURE_SEND") ? "FIXTURE_MAILBOX_REPLY"
    : incoming?.[2].startsWith("[consult]") ? "FIXTURE_CONSULT_ANSWER" : undefined;
  const available = (name: string) => body.tools?.some(tool => tool.name === name);
  const call = (name: string, args: object) => ({ type: "tool_use" as const, id: id("toolu"), name, input: args });
  const say = (text: string) => ({ type: "text" as const, text });
  const block = result ? say(`Fixture tool returned: ${JSON.stringify(result.content)}`)
    : prompt.includes("FIXTURE_LIST") && available("ListAgents") ? call("ListAgents", {})
    : (peer || reply) && available("SendMessage") ? call("SendMessage", {
      to: reply ? incoming?.[1] : peer?.[2],
      message: reply ?? (peer?.[1] ? "FIXTURE_CONSULT_TASK" : "model: gpt-5.4\n\nFIXTURE_CONSULT_TASK"),
      summary: "Exercise the local peer fixture",
    })
    : incoming?.[2].includes("FIXTURE_CODEX_REPLY") ? say("FIXTURE_CLAUDE_RECEIVED_CODEX_REPLY")
    : prompt.includes("Reply with the word OK and nothing else") ? say("OK")
    : say("FIXTURE_CLAUDE_OK");
  const usage = { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const stop_reason = block.type === "tool_use" ? "tool_use" : "end_turn";
  const message = { id: id("msg"), type: "message", role: "assistant", model: body.model, content: [block], stop_reason, stop_sequence: null, usage };
  log({ api: "messages", model: body.model, block, ...(result ? { result } : {}) });
  if (!body.stream) return Response.json(message);
  return stream(emit => {
    emit("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } });
    emit("content_block_start", { index: 0, content_block: block.type === "text" ? { ...block, text: "" } : { ...block, input: {} } });
    emit("content_block_delta", { index: 0, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    emit("content_block_stop", { index: 0 });
    emit("message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    emit("message_stop", {});
  }, error => log({ error: String(error) }));
}

function responses(body: RequestBody, log: (data: object) => void, brokerGate: PromiseWithResolvers<void>) {
  const input = typeof body.input === "string" ? [] : body.input ?? [];
  const prompt = typeof body.input === "string" ? body.input : text(input.findLast(item => item.role === "user")?.content);
  const returned = input.findLast(item => item.type === "function_call_output" || item.type === "custom_tool_call_output");
  const additionalTools = input.flatMap(item => item.type === "additional_tools" ? item.tools ?? [] : []);
  const tools = [...(body.tools ?? []), ...additionalTools];
  const namespace = tools.find(tool => tool.type === "namespace" && tool.name === "collab");
  const consult = namespace?.tools?.find(tool => tool.name === "consult") ?? tools.find(tool => /(?:^|[_.])consult$/.test(tool.name));
  const findConsultExec = (tools: Tool[]) => tools
    .filter(tool => tool.type === "namespace" && tool.name === "functions")
    .flatMap(tool => tool.tools ?? [])
    .find(tool => tool.type === "custom" && tool.name === "exec" && /\bcollab__consult\b/.test(tool.description ?? ""));
  const additionalExec = findConsultExec(additionalTools);
  const exec = additionalExec ?? findConsultExec(body.tools ?? []);
  const question = prompt.includes("FIXTURE_CONSULT_TASK") ? "FIXTURE_CONSULT_QUESTION?"
    : prompt.match(/\bCONTRACT-ARG-\d+\?/)?.[0];
  const args = JSON.stringify({ question });
  const marker = prompt.match(/\bFIXTURE_(?:RUN|DETACH|BROKER_A|BROKER_B|HELD)\b/)?.[0];
  const part = { type: "output_text", text: returned ? `FIXTURE_CODEX_REPLY ${JSON.stringify(returned.output)}` : marker ? `${marker}_OK` : "FIXTURE_CODEX_OK", annotations: [] };
  const item = question && !returned && consult
    ? { id: id("fc"), type: "function_call" as const, call_id: id("call"), name: consult.name, ...(namespace ? { namespace: namespace.name } : {}), arguments: args, status: "completed" }
    : question && !returned && exec
    ? { id: id("ctc"), type: "custom_tool_call" as const, call_id: id("call"), name: exec.name, namespace: "functions", input: `text(await tools.collab__consult(${args}));`, status: "completed" }
    : { id: id("msg"), type: "message" as const, role: "assistant", status: "completed", content: [part] };
  const response = { id: id("resp"), object: "response", created_at: Math.floor(Date.now() / 1000), model: body.model, output: [], status: "in_progress" };
  const usage = { input_tokens: 2, output_tokens: 3, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  log({ api: "responses", model: body.model, marker, item,
    ...(item.type === "custom_tool_call" ? { toolSource: additionalExec ? "additional_tools" : "tools" } : {}),
    ...(returned ? { returned: returned.output } : {}),
  });
  return stream(async emit => {
    let sequence_number = 0;
    const event = (type: string, data: object) => emit(type, { sequence_number: sequence_number++, ...data });
    event("response.created", { response });
    if (prompt.includes("FIXTURE_TIMEOUT")) await Bun.sleep(4500);
    const fail = (message: string) => event("response.failed", { response: { ...response, status: "failed", error: { code: "invalid_prompt", message } } });
    if (prompt.includes("FIXTURE_ERROR")) {
      fail("FIXTURE_MID_TURN_ERROR");
      return;
    }
    if (marker === "FIXTURE_BROKER_B") brokerGate.resolve();
    if (marker === "FIXTURE_BROKER_A") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 25_000); });
      const overlapped = await Promise.race([brokerGate.promise.then(() => true), timeout]);
      clearTimeout(timer);
      if (!overlapped) {
        fail("Second broker turn never reached the fixture");
        return;
      }
    }
    if (marker === "FIXTURE_DETACH") await Bun.sleep(1700);
    const pos = { item_id: item.id, output_index: 0 };
    if (item.type === "message") {
      event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      event("response.content_part.added", { ...pos, content_index: 0, part: { ...part, text: "" } });
      event("response.output_text.delta", { ...pos, content_index: 0, delta: part.text });
      event("response.output_text.done", { ...pos, content_index: 0, text: part.text });
      event("response.content_part.done", { ...pos, content_index: 0, part });
    } else if (item.type === "function_call") {
      event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", arguments: "" } });
      event("response.function_call_arguments.delta", { ...pos, delta: item.arguments });
      event("response.function_call_arguments.done", { ...pos, arguments: item.arguments });
    }
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response: { ...response, status: "completed", output: [item], usage } });
  }, error => log({ error: String(error) }));
}

export function startFakeServer(log: (data: object) => void) {
  const brokerGate = Promise.withResolvers<void>();
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    async fetch(req) {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const path = new URL(req.url).pathname;
      if (path === "/v1/messages/count_tokens") return Response.json({ input_tokens: 2 });
      if (path !== "/v1/messages" && path !== "/v1/responses") return new Response(null, { status: 404 });
      const body = await req.json() as RequestBody;
      return path === "/v1/messages" ? anthropic(body, log) : responses(body, log, brokerGate);
    },
  });
}
