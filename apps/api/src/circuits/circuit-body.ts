import { pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import {
  ApiError,
  LIMITS,
  MEDIA_TYPES,
  circuitInputFromNetlist,
  parseCircuitInput,
  parseCircuitWriteQuery,
  requestMediaType,
} from "@circuitlab/api-contract";
import type { CircuitInput, CircuitWriteQuery } from "@circuitlab/api-contract";
import { importNetlist } from "@circuitlab/netlist";
import type { Request } from "express";
import { header } from "../common/http";

/**
 * Reads the body of createCircuit or replaceCircuit: JSON (already parsed by Express), or a netlist
 * file, which is streamed straight from the socket into the netlist parser (phase 2), so a large
 * upload is never held in memory as one string.
 *
 * @throws ApiError 415, 413, 400, or 422, and the netlist parser's NetlistError (422)
 */
export async function readCircuitBody(
  operationId: "createCircuit" | "replaceCircuit",
  request: Request,
): Promise<{ input: CircuitInput; query: CircuitWriteQuery }> {
  const mediaType = requestMediaType(operationId, header(request.headers["content-type"]));
  const kind = mediaType === MEDIA_TYPES.json ? "json" : "netlist";
  const query = parseCircuitWriteQuery(operationId, request.query, kind);
  if (kind === "json") return { input: parseCircuitInput(request.body), query };

  const circuit = await importNetlist(netlistBytes(request), { maxGates: LIMITS.maxGates, source: "body" });
  return { input: circuitInputFromNetlist(circuit, query), query };
}

/**
 * The request's bytes, decompressed if sent with `Content-Encoding: gzip`, and cut off past
 * `LIMITS.maxBodyBytes`. Counting *after* decompression also stops a "zip bomb" (a small upload
 * that inflates to gigabytes).
 */
function netlistBytes(request: Request): AsyncIterable<Buffer> {
  const encoding = (header(request.headers["content-encoding"]) ?? "identity").trim().toLowerCase();
  if (encoding !== "identity" && encoding !== "gzip") {
    throw new ApiError("unsupported-media-type", `Content-Encoding "${encoding}" is not supported; send the netlist plain or gzipped.`);
  }
  if (Number(header(request.headers["content-length"])) > LIMITS.maxBodyBytes) throw tooLarge();
  // The callback form of pipeline returns its last stream and wires up error handling and cleanup
  // between the two; the error itself reaches the reader of that last stream.
  const source = encoding === "gzip" ? pipeline(request, createGunzip(), () => {}) : request;
  return limited(source, LIMITS.maxBodyBytes);
}

async function* limited(source: AsyncIterable<Buffer>, maxBytes: number): AsyncGenerator<Buffer, void, undefined> {
  let total = 0;
  try {
    for await (const chunk of source) {
      total += chunk.length;
      if (total > maxBytes) throw tooLarge();
      yield chunk;
    }
  } catch (error) {
    // zlib reports a damaged or non-gzip body with codes such as Z_DATA_ERROR.
    if (typeof (error as { code?: unknown }).code === "string" && (error as { code: string }).code.startsWith("Z_")) {
      throw new ApiError("malformed-body", "The body is not valid gzip data.");
    }
    throw error;
  }
}

function tooLarge(): ApiError {
  return new ApiError("content-too-large", `The body is larger than ${LIMITS.maxBodyBytes / (1024 * 1024)} MB (after decompression).`);
}
