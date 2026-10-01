// An HTTP client for the integration tests that checks every response against openapi.yaml, so
// each test is also a contract test: the status must be one the spec documents for that
// operation, and a JSON body must match the schema the spec gives for that status.

import { openApi, validateAgainstSchema } from "@circuitlab/api-contract";
import { expect } from "vitest";

/** A signed-in user, as the tests know them. */
export interface Person {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly id: string;
  token: string;
  refreshToken: string;
}

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** The parsed body, for JSON responses. */
  readonly body: any;
}

export interface CallOptions {
  /** Who is calling: their access token goes in the Authorization header. Absent: signed out. */
  readonly as?: Person | undefined;
  /** Sent as JSON. */
  readonly json?: unknown;
  /** Sent as it is (a netlist, a malformed body, ...). */
  readonly body?: string | Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
}

interface Spec {
  paths: Record<string, Record<string, { operationId: string; responses: Record<string, any> }>>;
  components: { responses: Record<string, any> };
}
const spec = openApi as unknown as Spec;

/** Each path template as a regular expression, e.g. /circuits/{circuitId} -> ^/circuits/[^/]+$ */
const TEMPLATES = Object.keys(spec.paths).map((template) => ({
  template,
  pattern: new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`),
}));

export class Api {
  /** "operationId status" pairs seen, to check that every operation is exercised. */
  readonly exercised = new Set<string>();

  constructor(readonly base: string) {}

  async call(method: string, path: string, options: CallOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = {
      ...(options.json !== undefined && { "Content-Type": "application/json" }),
      ...(options.as !== undefined && { Authorization: `Bearer ${options.as.token}` }),
      ...options.headers,
    };
    // fetch takes bytes as a plain Uint8Array; a Node Buffer (gzipSync, readFileSync) is copied into one.
    const body = options.json !== undefined ? JSON.stringify(options.json) : typeof options.body === "string" ? options.body : options.body && new Uint8Array(options.body);
    const response = await fetch(this.base + path, { method, headers, ...(body !== undefined && { body }) });
    const text = await response.text();
    const type = response.headers.get("content-type") ?? "";
    const reply: Reply = { status: response.status, headers: response.headers, text, body: /json/.test(type) && !/ndjson/.test(type) && text !== "" ? JSON.parse(text) : undefined };
    this.checkContract(method, path, reply, type);
    return reply;
  }

  get = (path: string, options?: CallOptions): Promise<Reply> => this.call("GET", path, options);
  post = (path: string, options?: CallOptions): Promise<Reply> => this.call("POST", path, options);
  put = (path: string, options?: CallOptions): Promise<Reply> => this.call("PUT", path, options);
  patch = (path: string, options?: CallOptions): Promise<Reply> => this.call("PATCH", path, options);
  delete = (path: string, options?: CallOptions): Promise<Reply> => this.call("DELETE", path, options);

  private checkContract(method: string, path: string, reply: Reply, type: string): void {
    const where = `${method} ${path} -> ${reply.status}`;
    expect(reply.status, `${where}: a 500 is always a bug\n${reply.text}`).not.toBe(500);
    // Every API error is a problem document. (/health is not part of the API: its 503 is a status report.)
    if (reply.status >= 400 && path.startsWith("/v1/")) {
      expect(type, where).toMatch(/^application\/problem\+json/);
      expect(validateAgainstSchema("Problem", reply.body), where).toEqual([]);
    }

    const route = path.split("?")[0]?.replace(/^\/v1/, "") ?? "";
    const template = TEMPLATES.find((candidate) => candidate.pattern.test(route))?.template;
    const operation = template === undefined ? undefined : spec.paths[template]?.[method.toLowerCase()];
    if (operation === undefined) return; // not an API operation (/health, or a path that doesn't exist)
    this.exercised.add(`${operation.operationId} ${reply.status}`);

    let response = operation.responses[String(reply.status)];
    expect(response, `${where}: ${operation.operationId} doesn't document status ${reply.status}`).toBeDefined();
    if (typeof response?.$ref === "string") response = spec.components.responses[response.$ref.split("/").pop() ?? ""];
    const mediaType = type.split(";")[0]?.trim() ?? "";
    const schema = response?.content?.[mediaType]?.schema;
    if (reply.body !== undefined && typeof schema?.$ref === "string") {
      const name = schema.$ref.split("/").pop() ?? "";
      expect(validateAgainstSchema(name, reply.body), `${where}: body vs ${name}`).toEqual([]);
    }
  }
}
