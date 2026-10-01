import { CircuitValidationError, type ValidationIssue } from "./errors";
import { GATE_ARITY, isGateType } from "./gates";
import { isInteger, isRecord, quote, showValue } from "./internal/util";
import { GATE_TYPES, type Circuit, type GateType } from "./types";

/** What the later passes need to know about a gate that has a usable id. */
interface KnownGate {
  readonly index: number;
  /** `undefined` when the type is unknown (already reported); such gates skip pin checks. */
  readonly type: GateType | undefined;
}

/** gate id -> (input pin -> index of the first wire driving that pin) */
type PinDrivers = Map<string, Map<number, number>>;

/**
 * Checks a circuit that may come straight from `JSON.parse`, so nothing about its shape is
 * assumed. Returns every problem found; an empty array means the circuit is valid.
 *
 * Feedback loops are not reported here: they are a property of the whole graph, found by
 * `topologicalSort` (which `compileCircuit` runs after validation).
 */
export function validateCircuit(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isRecord(input)) {
    issues.push({
      code: "MALFORMED_CIRCUIT",
      message: `A circuit must be an object with "gates" and "wires" arrays, got ${showValue(input)}`,
    });
    return issues;
  }
  if (input.name !== undefined && typeof input.name !== "string") {
    issues.push({ code: "MALFORMED_CIRCUIT", message: `"name" must be a string, got ${showValue(input.name)}` });
  }

  const gates = arrayField(input, "gates", issues);
  const wires = arrayField(input, "wires", issues);

  const known = checkGates(gates, issues);
  const drivers = checkWires(wires, known, issues);
  checkUnconnectedPins(known, drivers, issues);

  return issues;
}

/**
 * Throws a `CircuitValidationError` carrying every issue if the circuit is invalid.
 * Afterwards TypeScript treats `input` as a `Circuit`.
 */
export function assertValidCircuit(input: unknown): asserts input is Circuit {
  const issues = validateCircuit(input);
  if (issues.length > 0) throw new CircuitValidationError(issues);
}

function arrayField(circuit: Record<string, unknown>, field: "gates" | "wires", issues: ValidationIssue[]): readonly unknown[] {
  const value = circuit[field];
  if (Array.isArray(value)) return value;
  issues.push({ code: "MALFORMED_CIRCUIT", message: `"${field}" must be an array, got ${showValue(value)}` });
  return []; // keep going, so problems in the other array are still reported
}

/** Pass 1: each gate on its own, plus id uniqueness. */
function checkGates(gates: readonly unknown[], issues: ValidationIssue[]): Map<string, KnownGate> {
  const known = new Map<string, KnownGate>();

  gates.forEach((raw, gateIndex) => {
    if (!isRecord(raw)) {
      issues.push({ code: "MALFORMED_GATE", message: `gates[${gateIndex}] must be an object, got ${showValue(raw)}`, gateIndex });
      return;
    }

    const { id, type, label } = raw;
    const hasId = typeof id === "string" && id.length > 0;
    const where = hasId ? { gateId: id, gateIndex } : { gateIndex };
    const gateName = hasId ? `Gate ${quote(id)}` : `gates[${gateIndex}]`;

    if (!hasId) {
      issues.push({
        code: "MALFORMED_GATE",
        message: `gates[${gateIndex}] needs a non-empty string "id", got ${showValue(id)}`,
        gateIndex,
      });
    }

    const gateType = isGateType(type) ? type : undefined;
    if (gateType === undefined) {
      issues.push({
        code: "UNKNOWN_GATE_TYPE",
        message: `${gateName} has unknown type ${showValue(type)} (expected one of ${GATE_TYPES.join(", ")})`,
        ...where,
      });
    }

    if (label !== undefined && typeof label !== "string") {
      issues.push({ code: "MALFORMED_GATE", message: `${gateName} has a non-string "label": ${showValue(label)}`, ...where });
    }

    if (gateType === "CONST" && raw.value !== 0 && raw.value !== 1) {
      issues.push({
        code: "INVALID_CONST_VALUE",
        message: `${gateName} is a CONST and needs a "value" of 0 or 1, got ${showValue(raw.value)}`,
        ...where,
      });
    }

    if (!hasId) return;
    const first = known.get(id);
    if (first !== undefined) {
      issues.push({
        code: "DUPLICATE_GATE_ID",
        message: `Gate id ${quote(id)} is used by both gates[${first.index}] and gates[${gateIndex}]`,
        ...where,
      });
    } else {
      known.set(id, { index: gateIndex, type: gateType });
    }
  });

  return known;
}

/** Pass 2: each wire's shape and endpoints, pin ranges, and pins driven twice. */
function checkWires(wires: readonly unknown[], known: Map<string, KnownGate>, issues: ValidationIssue[]): PinDrivers {
  const drivers: PinDrivers = new Map();
  const wireIds = new Map<string, number>();

  wires.forEach((raw, wireIndex) => {
    const wireName = `wires[${wireIndex}]`;
    if (!isRecord(raw)) {
      issues.push({ code: "MALFORMED_WIRE", message: `${wireName} must be an object, got ${showValue(raw)}`, wireIndex });
      return;
    }
    const { id, from, to, toPin } = raw;

    if (id !== undefined) {
      if (typeof id !== "string" || id.length === 0) {
        issues.push({
          code: "MALFORMED_WIRE",
          message: `${wireName} has an "id" that is not a non-empty string: ${showValue(id)}`,
          wireIndex,
        });
      } else {
        const first = wireIds.get(id);
        if (first !== undefined) {
          issues.push({
            code: "DUPLICATE_WIRE_ID",
            message: `Wire id ${quote(id)} is used by both wires[${first}] and ${wireName}`,
            wireIndex,
          });
        } else {
          wireIds.set(id, wireIndex);
        }
      }
    }

    // Source end.
    if (typeof from !== "string" || from.length === 0) {
      issues.push({ code: "MALFORMED_WIRE", message: `${wireName} needs a non-empty string "from", got ${showValue(from)}`, wireIndex });
    } else {
      const source = known.get(from);
      if (source === undefined) {
        issues.push({ code: "UNKNOWN_SOURCE_GATE", message: `${wireName} comes from gate ${quote(from)}, which does not exist`, wireIndex });
      } else if (source.type === "OUTPUT") {
        issues.push({
          code: "OUTPUT_AS_SOURCE",
          message: `${wireName} comes from OUTPUT gate ${quote(from)}; OUTPUT gates cannot drive other gates`,
          gateId: from,
          wireIndex,
        });
      }
    }

    // Destination end.
    let target: KnownGate | undefined;
    if (typeof to !== "string" || to.length === 0) {
      issues.push({ code: "MALFORMED_WIRE", message: `${wireName} needs a non-empty string "to", got ${showValue(to)}`, wireIndex });
    } else {
      target = known.get(to);
      if (target === undefined) {
        issues.push({ code: "UNKNOWN_TARGET_GATE", message: `${wireName} goes to gate ${quote(to)}, which does not exist`, wireIndex });
      }
    }

    if (!isInteger(toPin)) {
      issues.push({ code: "MALFORMED_WIRE", message: `${wireName} needs a whole-number "toPin", got ${showValue(toPin)}`, wireIndex });
      return;
    }
    if (typeof to !== "string" || target?.type === undefined) return; // already reported

    // Pin checks. Note that a wire with a bad source still occupies its pin: reporting
    // "unknown source" and then "unconnected pin" for the same mistake would just be noise.
    const { max } = GATE_ARITY[target.type];
    const where = { gateId: to, wireIndex, pin: toPin };
    if (toPin < 0 || toPin >= max) {
      const available = max === 0 ? "has no input pins" : max === 1 ? "only has pin 0" : `has pins 0-${max - 1}`;
      issues.push({
        code: "PIN_OUT_OF_RANGE",
        message: `${wireName} goes to pin ${toPin} of ${target.type} gate ${quote(to)}, which ${available}`,
        ...where,
      });
      return;
    }

    let pins = drivers.get(to);
    if (pins === undefined) {
      pins = new Map();
      drivers.set(to, pins);
    }
    const firstDriver = pins.get(toPin);
    if (firstDriver !== undefined) {
      issues.push({
        code: "MULTIPLE_DRIVERS",
        message: `Pin ${toPin} of ${target.type} gate ${quote(to)} is driven by both wires[${firstDriver}] and ${wireName}`,
        ...where,
      });
    } else {
      pins.set(toPin, wireIndex);
    }
  });

  return drivers;
}

/**
 * Pass 3: every input pin a gate uses must be driven. A gate uses pins
 * 0 .. max(minimum arity, highest wired pin + 1) - 1, so a 2-input AND needs pins 0 and 1,
 * and wiring pins 0 and 2 of an AND leaves a gap at pin 1.
 */
function checkUnconnectedPins(known: Map<string, KnownGate>, drivers: PinDrivers, issues: ValidationIssue[]): void {
  for (const [gateId, gate] of known) {
    if (gate.type === undefined) continue;
    const { min } = GATE_ARITY[gate.type];
    const pins = drivers.get(gateId);
    let highestWired = -1;
    for (const pin of pins?.keys() ?? []) highestWired = Math.max(highestWired, pin);
    const pinCount = Math.max(min, highestWired + 1);

    for (let pin = 0; pin < pinCount; pin++) {
      if (pins?.has(pin)) continue;
      const hint =
        pin < highestWired
          ? `, but pin ${highestWired} is (pins must be numbered from 0 without gaps)`
          : min > 1
            ? ` (${gate.type} needs at least ${min} inputs)`
            : "";
      issues.push({
        code: "UNCONNECTED_PIN",
        message: `Pin ${pin} of ${gate.type} gate ${quote(gateId)} is not connected${hint}`,
        gateId,
        gateIndex: gate.index,
        pin,
      });
    }
  }
}
