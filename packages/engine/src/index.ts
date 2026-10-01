export { GATE_TYPES } from "./types";
export type { Bit, Circuit, ConstGate, Gate, GateType, InputGate, LogicGate, LogicGateType, OutputGate, Wire } from "./types";

// The gate registry and the gate factory.
export { GATE_ARITY, GATE_DEFINITIONS, MAX_GATE_INPUTS, isGateType } from "./gates";
export type { Arity, Evaluator, GateBehaviour, GateDefinition } from "./gates";
export { createGateNode } from "./gate-factory";
export type { GateNode } from "./gate-factory";

export {
  CircuitLabError,
  CircuitValidationError,
  CycleError,
  INPUT_ISSUE_CODES,
  OscillationError,
  SimulationInputError,
  VALIDATION_ISSUE_CODES,
  reviveError,
} from "./errors";
export type { ErrorData, InputIssue, InputIssueCode, ValidationIssue, ValidationIssueCode } from "./errors";

export { assertValidCircuit, validateCircuit } from "./validate";
export { topologicalSort } from "./topological-sort";
export { CompiledCircuit, compileCircuit } from "./compile";
export { simulate } from "./simulate";
export type { SimulationInputs, SimulationState } from "./inputs";

// The simulation strategies.
export { SIMULATION_MODES } from "./results";
export type { CombinationalResult, ModeResult, PreparedCircuit, SequentialResult, SimulationMode, SimulationResult } from "./results";
export { SequentialCircuit } from "./sequential";
export type { SequentialOptions } from "./sequential";
export { combinational, sequential, sequentialStrategy, simulationStrategy } from "./strategies";
export type { SimulationStrategy } from "./strategies";

export { MAX_TRUTH_TABLE_INPUTS, inputsForRow, truthTable, truthTableRows } from "./truth-table";
export type { TruthTable, TruthTableRange, TruthTableRow } from "./truth-table";
