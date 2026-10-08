import { createServer } from "node:http";

/**
 * Loopback mock of Grok Bot's gateway (POST /api/<method>, Bearer token). The
 * scripted "agent" answers from `behavior(prompt, request)` which returns a
 * list of reply messages: { text } | { file: { name, bytes } } | { approval: true }.
 */
export async function startMockGateway({ token = "test-token", agents, behavior }) {
  const transcripts = new Map(agents.map((agent) => [agent.id, []]));
  const uploads = [];
  const prompts = [];
  const files = new Map();
  let seq = 0;
  const nextId = (prefix) => `${prefix}-${++seq}`;

  const handlers = {
    listAgents: () => ({ agents: agents.map((agent) => ({ ...agent, isRunning: false, isComposingMessage: false })) }),
    uploadAttachment: ({ agentId, filename, bytesBase64 }) => {
      const path = `/uploads/${agentId}/${seq += 1}-${filename}`;
      uploads.push({ agentId, filename, path, bytes: Buffer.from(bytesBase64, "base64") });
      return { path };
    },
    sendPrompt: (request) => {
      const { agentId, prompt, clientNonce } = request;
      if (!transcripts.has(agentId)) throw Object.assign(new Error("unknown agent"), { status: 404 });
      prompts.push(request);
      const entries = transcripts.get(agentId);
      entries.push({ id: nextId("prompt"), kind: "message", role: "user", clientNonce, prompt });
      const replies = behavior(prompt, request) ?? [];
      setTimeout(() => {
        for (const reply of replies) {
          if (reply.text !== undefined) entries.push({ id: nextId("reply"), kind: "send-message", message: { type: "text", content: reply.text } });
          if (reply.file) {
            const url = `/agent-files/${reply.file.name}`;
            files.set(url, Buffer.from(reply.file.bytes));
            entries.push({ id: nextId("file"), kind: "send-message", message: { type: "attachment", url, file_name: reply.file.name } });
          }
          if (reply.approval) entries.push({ id: nextId("approval"), kind: "send-message", message: { type: "auto-review-approval", approval: { status: "pending", requestId: "r1", summary: "run a command" } } });
        }
      }, 15);
      return { accepted: true };
    },
    getAgentTranscriptTail: ({ id, limit = 200 }) => ({ entries: (transcripts.get(id) ?? []).slice(-limit) }),
    getAgentTranscript: ({ id }) => ({ entries: transcripts.get(id) ?? [] }),
    readAttachmentChunk: ({ path, offset = 0, length }) => {
      const bytes = files.get(path);
      if (!bytes) throw Object.assign(new Error("missing"), { status: 404 });
      return { bytesBase64: bytes.subarray(offset, offset + length).toString("base64"), totalSize: bytes.length };
    },
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const reply = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "unauthorized" });
      const method = req.url.replace(/^\/api\//, "");
      const handler = handlers[method];
      if (req.method !== "POST" || !handler) return reply(404, { error: "not found" });
      try {
        return reply(200, { result: handler(JSON.parse(body || "{}")) });
      } catch (error) {
        return reply(error.status ?? 500, { error: error.message });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    prompts,
    uploads,
    transcripts,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
