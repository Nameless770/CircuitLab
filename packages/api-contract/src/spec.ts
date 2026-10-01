// Loads openapi.yaml, the single source of truth for the API's shape. Validation, content
// negotiation, and documentation all read it, so they can't disagree with each other.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/** Absolute path of the OpenAPI document, e.g. to serve it with Swagger UI. */
export const OPENAPI_PATH = join(__dirname, "..", "openapi.yaml");

export interface ParameterObject {
  readonly name: string;
  readonly in: "query" | "path" | "header" | "cookie";
  readonly required?: boolean;
  readonly schema?: unknown;
}

interface Reference {
  readonly $ref: string;
}

interface MediaTypes {
  readonly content?: Readonly<Record<string, { readonly schema?: unknown }>>;
}

interface OperationObject {
  readonly operationId: string;
  readonly parameters?: readonly (ParameterObject | Reference)[];
  readonly requestBody?: MediaTypes;
  readonly responses: Readonly<Record<string, MediaTypes | Reference>>;
}

interface OpenApiDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>> & { readonly parameters?: readonly (ParameterObject | Reference)[] }>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, unknown>>;
    readonly parameters: Readonly<Record<string, ParameterObject>>;
  };
}

/** The parsed document, read once when this module loads. */
export const openApi = parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiDocument;

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options"]);

export interface Operation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  /** Path-level and operation-level parameters, with references resolved. */
  readonly parameters: readonly ParameterObject[];
  /** Media types the request body may have, in the order the spec lists them. */
  readonly requestMediaTypes: readonly string[];
  /** Media types of the success response, the first being the default. */
  readonly responseMediaTypes: readonly string[];
}

const operations = new Map<string, Operation>();
for (const [path, item] of Object.entries(openApi.paths)) {
  for (const [method, value] of Object.entries(item)) {
    if (!HTTP_METHODS.has(method)) continue;
    const operation = value as OperationObject;
    const success = Object.entries(operation.responses).find(([status]) => status.startsWith("2"))?.[1];
    operations.set(operation.operationId, {
      id: operation.operationId,
      method: method.toUpperCase(),
      path,
      parameters: [...(item.parameters ?? []), ...(operation.parameters ?? [])].map(resolveParameter),
      requestMediaTypes: Object.keys(operation.requestBody?.content ?? {}),
      responseMediaTypes: success !== undefined && !("$ref" in success) ? Object.keys(success.content ?? {}) : [],
    });
  }
}

export function operation(operationId: string): Operation {
  const found = operations.get(operationId);
  if (found === undefined) throw new Error(`openapi.yaml has no operation "${operationId}"`);
  return found;
}

export function allOperations(): readonly Operation[] {
  return [...operations.values()];
}

function resolveParameter(parameter: ParameterObject | Reference): ParameterObject {
  if (!("$ref" in parameter)) return parameter;
  const name = parameter.$ref.replace("#/components/parameters/", "");
  const resolved = openApi.components.parameters[name];
  if (resolved === undefined) throw new Error(`openapi.yaml: unresolved reference ${parameter.$ref}`);
  return resolved;
}
