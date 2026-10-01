export { GATE_TYPES } from "./types";
export type { Bit, Circuit, ConstGate, Gate, GateType, InputGate, LogicGate, LogicGateType, OutputGate, Wire } from "./types";

export { GATE_ARITY, MAX_GATE_INPUTS, isGateType } from "./gates";
export type { Arity, Evaluator } from "./gates";

export {
  CircuitLabError,
  CircuitValidationError,
  CycleError,
  INPUT_ISSUE_CODES,
  SimulationInputError,
  VALIDATION_ISSUE_CODES,
  reviveError,
} from "./errors";
export type { ErrorData, InputIssue, InputIssueCode, ValidationIssue, ValidationIssueCode } from "./errors";

export { assertValidCircuit, validateCircuit } from "./validate";
export { topologicalSort } from "./topological-sort";
export { CompiledCircuit, compileCircuit } from "./compile";
export { simulate } from "./simulate";
export type { SimulationInputs, SimulationResult } from "./simulate";
export { MAX_TRUTH_TABLE_INPUTS, inputsForRow, truthTable, truthTableRows } from "./truth-table";
export type { TruthTable, TruthTableRange, TruthTableRow } from "./truth-table";
