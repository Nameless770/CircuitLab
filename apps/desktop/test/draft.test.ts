import { describe, expect, it } from "vitest";
import {
  addGate,
  connect,
  emptyDraft,
  nextGateId,
  removeGate,
  removeWire,
  renameGate,
  setConstValue,
  setLabel,
  setPinCount,
  toCircuitInput,
  type Draft,
} from "../src/editor/draft";

/** A draft with inputs A and B, an AND gate and an output, not wired yet. */
function andDraft(): Draft {
  const draft = emptyDraft();
  addGate(draft, "INPUT", { x: 0, y: 0 });
  addGate(draft, "INPUT", { x: 0, y: 60 });
  addGate(draft, "AND", { x: 150, y: 30 });
  addGate(draft, "OUTPUT", { x: 300, y: 30 });
  return draft;
}

describe("nextGateId", () => {
  it("names inputs A, B, C... and outputs Y, Z, then out1...", () => {
    expect(nextGateId("INPUT", new Set())).toBe("A");
    expect(nextGateId("INPUT", new Set(["A", "B"]))).toBe("C");
    expect(nextGateId("OUTPUT", new Set(["Y"]))).toBe("Z");
    expect(nextGateId("OUTPUT", new Set(["Y", "Z"]))).toBe("out1");
  });

  it("numbers the other gates by type", () => {
    expect(nextGateId("AND", new Set())).toBe("and1");
    expect(nextGateId("AND", new Set(["and1", "and2"]))).toBe("and3");
    expect(nextGateId("XNOR", new Set(["and1"]))).toBe("xnor1");
  });
});

describe("addGate", () => {
  it("adds a gate with the fewest pins its type allows, where asked", () => {
    const draft = andDraft();
    expect(draft.gates.map((gate) => gate.id)).toEqual(["A", "B", "and1", "Y"]);
    expect(draft.pins.get("and1")).toBe(2);
    expect(draft.positions.get("and1")).toEqual({ x: 150, y: 30 });
  });

  it("gives CONST gates a value", () => {
    const draft = emptyDraft();
    expect(addGate(draft, "CONST", { x: 0, y: 0 })).toEqual({ id: "const1", type: "CONST", value: 0 });
  });
});

describe("connect", () => {
  it("connects an output to an input pin", () => {
    const draft = andDraft();
    expect(connect(draft, "A", "and1", 0)).toBeNull();
    expect(draft.wires).toEqual([{ from: "A", to: "and1", toPin: 0 }]);
  });

  it("replaces the wire already on that pin: an input pin takes one wire", () => {
    const draft = andDraft();
    connect(draft, "A", "and1", 0);
    connect(draft, "B", "and1", 0);
    expect(draft.wires).toEqual([{ from: "B", to: "and1", toPin: 0 }]);
  });

  it("refuses an OUTPUT as a source, and pins that don't exist", () => {
    const draft = andDraft();
    expect(connect(draft, "Y", "and1", 0)).toMatch(/OUTPUT/);
    expect(connect(draft, "A", "and1", 2)).toMatch(/no input pin 2/);
    expect(connect(draft, "ghost", "and1", 0)).not.toBeNull();
    expect(draft.wires).toEqual([]);
  });
});

describe("renameGate", () => {
  it("renames the gate everywhere: wires, pins and position", () => {
    const draft = andDraft();
    connect(draft, "A", "and1", 0);
    connect(draft, "and1", "Y", 0);
    expect(renameGate(draft, "and1", "both")).toBeNull();
    expect(draft.gates.map((gate) => gate.id)).toContain("both");
    expect(draft.wires).toEqual([
      { from: "A", to: "both", toPin: 0 },
      { from: "both", to: "Y", toPin: 0 },
    ]);
    expect(draft.pins.has("both")).toBe(true);
    expect(draft.positions.has("and1")).toBe(false);
  });

  it("refuses names that are taken or not allowed", () => {
    const draft = andDraft();
    expect(renameGate(draft, "and1", "A")).toMatch(/already/);
    expect(renameGate(draft, "and1", ".dot")).not.toBeNull();
    expect(renameGate(draft, "and1", "has space")).not.toBeNull();
    expect(renameGate(draft, "and1", "x".repeat(65))).not.toBeNull();
    expect(draft.gates.map((gate) => gate.id)).toContain("and1");
  });
});

describe("removing", () => {
  it("removes a gate together with its wires", () => {
    const draft = andDraft();
    connect(draft, "A", "and1", 0);
    connect(draft, "and1", "Y", 0);
    removeGate(draft, "and1");
    expect(draft.gates.map((gate) => gate.id)).toEqual(["A", "B", "Y"]);
    expect(draft.wires).toEqual([]);
  });

  it("removes one wire", () => {
    const draft = andDraft();
    connect(draft, "A", "and1", 0);
    connect(draft, "B", "and1", 1);
    removeWire(draft, 0);
    expect(draft.wires).toEqual([{ from: "B", to: "and1", toPin: 1 }]);
  });
});

describe("setPinCount", () => {
  it("drops the wires of pins that go away, and keeps within 2 to 64", () => {
    const draft = andDraft();
    setPinCount(draft, "and1", 3);
    connect(draft, "A", "and1", 2);
    setPinCount(draft, "and1", 2);
    expect(draft.wires).toEqual([]);
    setPinCount(draft, "and1", 1000);
    expect(draft.pins.get("and1")).toBe(64);
    setPinCount(draft, "and1", 0);
    expect(draft.pins.get("and1")).toBe(2);
  });
});

describe("labels and values", () => {
  it("sets a label, and removes it when blank", () => {
    const draft = andDraft();
    setLabel(draft, "A", "  First number ");
    expect(draft.gates[0]).toEqual({ id: "A", type: "INPUT", label: "First number" });
    setLabel(draft, "A", "");
    expect(draft.gates[0]).toEqual({ id: "A", type: "INPUT" });
  });

  it("keeps a CONST gate's value when its label changes", () => {
    const draft = emptyDraft();
    addGate(draft, "CONST", { x: 0, y: 0 });
    setConstValue(draft, "const1", 1);
    setLabel(draft, "const1", "high");
    expect(draft.gates[0]).toEqual({ id: "const1", type: "CONST", value: 1, label: "high" });
  });
});

describe("toCircuitInput", () => {
  it("trims the name and leaves out a blank description", () => {
    const draft = andDraft();
    draft.name = "  AND test  ";
    draft.description = "   ";
    expect(toCircuitInput(draft)).toEqual({ name: "AND test", gates: draft.gates, wires: draft.wires });
    draft.description = "Two inputs.";
    expect(toCircuitInput(draft).description).toBe("Two inputs.");
  });
});
