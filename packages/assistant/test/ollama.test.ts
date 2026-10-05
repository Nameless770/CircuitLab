import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantError, OllamaClient, listModels, type AssistantErrorCode } from "@circuitlab/assistant";

/** A web server that answers like Ollama (or doesn't), and remembers what it was asked. */
interface FakeOllama {
  readonly url: string;
  readonly requests: { method: string; path: string; body: unknown }[];
}

const servers: Server[] = [];

async function fakeOllama(respond: (request: IncomingMessage, response: ServerResponse) => void): Promise<FakeOllama> {
  const requests: FakeOllama["requests"] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method ?? "", path: request.url ?? "", body: text === "" ? undefined : JSON.parse(text) });
      respond(request, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function failureOf(promise: Promise<unknown>): Promise<AssistantError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AssistantError) return error;
    throw error;
  }
  throw new Error("expected an AssistantError");
}

const codeOf = async (promise: Promise<unknown>): Promise<AssistantErrorCode> => (await failureOf(promise)).code;

describe("OllamaClient.chat", () => {
  it("sends the conversation to /api/chat, whole and once, and gives back the text", async () => {
    const ollama = await fakeOllama((_request, response) => json(response, 200, { message: { role: "assistant", content: "hello" }, done: true }));
    const client = new OllamaClient({ model: "llama3.2:3b", baseUrl: ollama.url });
    const reply = await client.chat([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }], { format: { type: "object" } });

    expect(reply).toBe("hello");
    expect(client.name).toBe("llama3.2:3b");
    expect(ollama.requests).toEqual([
      {
        method: "POST",
        path: "/api/chat",
        body: {
          model: "llama3.2:3b",
          messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }],
          stream: false,
          format: { type: "object" },
          // A steady model, a memory size we chose (Ollama would cut off what doesn't fit, silently), and an end to a rambling answer.
          options: { temperature: 0.2, num_ctx: 8192, num_predict: 1024 },
        },
      },
    ]);
  });

  it("leaves out the schema when there is none, and passes on a seed and the other settings when given", async () => {
    const ollama = await fakeOllama((_request, response) => json(response, 200, { message: { content: "ok" } }));
    await new OllamaClient({ model: "m", baseUrl: ollama.url, seed: 7, temperature: 0, contextTokens: 4096, maxReplyTokens: 100 }).chat([{ role: "user", content: "x" }]);
    expect(ollama.requests[0]?.body).toEqual({ model: "m", messages: [{ role: "user", content: "x" }], stream: false, options: { temperature: 0, num_ctx: 4096, num_predict: 100, seed: 7 } });
  });

  it("says when the model isn't installed", async () => {
    const ollama = await fakeOllama((_request, response) => json(response, 404, { error: 'model "nope" not found, try pulling it first' }));
    const error = await failureOf(new OllamaClient({ model: "nope", baseUrl: ollama.url }).chat([{ role: "user", content: "x" }]));
    expect([error.code, error.message]).toEqual(["model-not-found", "The model “nope” isn't installed in Ollama. Pick another one in Settings."]);
  });

  it("passes on Ollama's own words for any other error", async () => {
    const ollama = await fakeOllama((_request, response) => json(response, 500, { error: "llama runner process has terminated" }));
    const error = await failureOf(new OllamaClient({ model: "m", baseUrl: ollama.url }).chat([{ role: "user", content: "x" }]));
    expect([error.code, error.message]).toEqual(["ollama-error", "Ollama answered with an error: llama runner process has terminated"]);
  });

  it("doesn't mistake some other web server's 404 for a missing model", async () => {
    const ollama = await fakeOllama((_request, response) => {
      response.writeHead(404, { "Content-Type": "text/html" });
      response.end("<h1>Not Found</h1>");
    });
    expect(await codeOf(new OllamaClient({ model: "m", baseUrl: ollama.url }).chat([{ role: "user", content: "x" }]))).toBe("ollama-error");
  });

  it("notices an answer that isn't Ollama's", async () => {
    const ollama = await fakeOllama((_request, response) => json(response, 200, { hello: "world" }));
    const error = await failureOf(new OllamaClient({ model: "m", baseUrl: ollama.url }).chat([{ role: "user", content: "x" }]));
    expect(error.code).toBe("bad-reply");
    expect(error.message).toContain("Check the address in Settings");
  });

  it("says when nothing is listening, and where it looked", async () => {
    const ollama = await fakeOllama(() => undefined);
    await new Promise<void>((resolve) => servers[0]?.close(() => resolve())); // the port is now closed
    const error = await failureOf(new OllamaClient({ model: "m", baseUrl: ollama.url }).chat([{ role: "user", content: "x" }]));
    expect(error.code).toBe("ollama-unreachable");
    expect(error.message).toContain(`Can't reach Ollama at ${ollama.url}`);
    expect(error.message).toContain("ECONNREFUSED");
  });

  it("gives up waiting after the time it was given", async () => {
    const ollama = await fakeOllama(() => undefined); // never answers
    const error = await failureOf(new OllamaClient({ model: "m", baseUrl: ollama.url, timeoutMs: 80 }).chat([{ role: "user", content: "x" }]));
    expect(error.code).toBe("timeout");
    expect(error.message).toMatch(/didn't answer within 0 seconds|didn't answer within \d+ seconds/);
  });

  it("stops when the person presses Cancel, while waiting or before starting", async () => {
    const ollama = await fakeOllama(() => undefined);
    const client = new OllamaClient({ model: "m", baseUrl: ollama.url });
    const during = new AbortController();
    const waiting = client.chat([{ role: "user", content: "x" }], { signal: during.signal });
    setTimeout(() => during.abort(), 30);
    expect(await codeOf(waiting)).toBe("cancelled");

    const before = new AbortController();
    before.abort();
    expect(await codeOf(client.chat([{ role: "user", content: "x" }], { signal: before.signal }))).toBe("cancelled");
  });
});

describe("listModels", () => {
  it("lists what is installed, in Ollama's order, with sizes", async () => {
    const ollama = await fakeOllama((_request, response) =>
      json(response, 200, {
        models: [
          { name: "qwen2.5-coder:7b", size: 4_700_000_000, details: { parameter_size: "7.6B", family: "qwen2" } },
          { name: "llama3.2:3b", size: 2_000_000_000, details: { parameter_size: "3.2B" } },
          { name: "no-details", size: 5 },
          { size: 1 }, // not a model
          "nonsense",
        ],
      }),
    );
    expect(await listModels(ollama.url)).toEqual([
      { name: "qwen2.5-coder:7b", sizeBytes: 4_700_000_000, parameterSize: "7.6B" },
      { name: "llama3.2:3b", sizeBytes: 2_000_000_000, parameterSize: "3.2B" },
      { name: "no-details", sizeBytes: 5, parameterSize: undefined },
    ]);
    expect(ollama.requests).toEqual([{ method: "GET", path: "/api/tags", body: undefined }]);
  });

  it("is an empty list when nothing is installed", async () => {
    const ollama = await fakeOllama((_request, response) => json(response, 200, { models: [] }));
    expect(await listModels(ollama.url)).toEqual([]);
  });

  it("recognises a server that isn't Ollama", async () => {
    const ollama = await fakeOllama((_request, response) => json(response, 200, { models: "many" }));
    expect(await codeOf(listModels(ollama.url))).toBe("bad-reply");
    const html = await fakeOllama((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<html></html>");
    });
    expect(await codeOf(listModels(html.url))).toBe("bad-reply");
  });

  it("says when Ollama isn't running", async () => {
    const ollama = await fakeOllama(() => undefined);
    await new Promise<void>((resolve) => servers[0]?.close(() => resolve()));
    expect(await codeOf(listModels(ollama.url))).toBe("ollama-unreachable");
  });

  it("can be stopped", async () => {
    const ollama = await fakeOllama(() => undefined);
    const controller = new AbortController();
    const pending = listModels(ollama.url, controller.signal);
    setTimeout(() => controller.abort(), 30);
    expect(await codeOf(pending)).toBe("cancelled");
  });
});
