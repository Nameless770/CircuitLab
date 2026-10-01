// The access rules, tested as the table they are (apps/api/src/circuits/circuit-access.ts): every
// kind of caller tries every kind of action, on a private circuit and on a public one.

import { beforeAll, describe, expect, it } from "vitest";
import type { Api, Person } from "../support/client";
import { createCircuit, halfAdderBody, register, type TestContext } from "../support/server";

type Actor = "owner" | "editor" | "viewer" | "stranger" | "signed out";
type Action = "read" | "simulate" | "truth table" | "history" | "rename" | "replace" | "change visibility" | "list shares" | "share";

const ACTORS: readonly Actor[] = ["owner", "editor", "viewer", "stranger", "signed out"];

/** The expected status for each actor and action. 2xx means allowed. */
const EXPECTED: Record<"private" | "public", Record<Actor, Record<Action, number>>> = {
  private: {
    owner: { read: 200, simulate: 200, "truth table": 200, history: 200, rename: 200, replace: 200, "change visibility": 200, "list shares": 200, share: 201 },
    editor: { read: 200, simulate: 200, "truth table": 200, history: 200, rename: 200, replace: 200, "change visibility": 403, "list shares": 403, share: 403 },
    viewer: { read: 200, simulate: 200, "truth table": 200, history: 200, rename: 403, replace: 403, "change visibility": 403, "list shares": 403, share: 403 },
    // Can't see it, so it doesn't exist for them: 404 for everything, never 403.
    stranger: { read: 404, simulate: 404, "truth table": 404, history: 404, rename: 404, replace: 404, "change visibility": 404, "list shares": 404, share: 404 },
    "signed out": { read: 404, simulate: 404, "truth table": 404, history: 401, rename: 401, replace: 401, "change visibility": 401, "list shares": 401, share: 401 },
  },
  public: {
    owner: { read: 200, simulate: 200, "truth table": 200, history: 200, rename: 200, replace: 200, "change visibility": 200, "list shares": 200, share: 201 },
    editor: { read: 200, simulate: 200, "truth table": 200, history: 200, rename: 200, replace: 200, "change visibility": 403, "list shares": 403, share: 403 },
    viewer: { read: 200, simulate: 200, "truth table": 200, history: 200, rename: 403, replace: 403, "change visibility": 403, "list shares": 403, share: 403 },
    // Anyone may read a public circuit; nobody new may change it.
    stranger: { read: 200, simulate: 200, "truth table": 200, history: 200, rename: 403, replace: 403, "change visibility": 403, "list shares": 403, share: 403 },
    "signed out": { read: 200, simulate: 200, "truth table": 200, history: 401, rename: 401, replace: 401, "change visibility": 401, "list shares": 401, share: 401 },
  },
};

/** The request for each action. `share` needs a fresh recipient each time, so it gets one. */
function attempt(api: Api, action: Action, id: string, as: Person | undefined, visibility: string, recipient: Person) {
  const path = `/v1/circuits/${id}`;
  switch (action) {
    case "read":
      return api.get(path, { as });
    case "simulate":
      return api.post(`${path}/simulate`, { as, json: { inputs: { A: 1, B: 1 } } });
    case "truth table":
      return api.get(`${path}/truth-table`, { as });
    case "history":
      return api.get(`${path}/runs`, { as });
    case "rename":
      return api.patch(path, { as, json: { description: `edited by ${as?.name ?? "nobody"}` } });
    case "replace":
      return api.put(path, { as, json: halfAdderBody() });
    case "change visibility":
      return api.patch(path, { as, json: { visibility } }); // the current value: still the owner's call
    case "list shares":
      return api.get(`${path}/shares`, { as });
    case "share":
      return api.post(`${path}/shares`, { as, json: { email: recipient.email, role: "viewer" } });
  }
}

export function accessSuite(context: () => TestContext): void {
  describe.each(["private", "public"] as const)("who may do what with a %s circuit", (visibility) => {
    const people: Partial<Record<Actor, Person>> = {};
    let id = "";

    beforeAll(async () => {
      const { api } = context();
      for (const actor of ["owner", "editor", "viewer", "stranger"] as const) people[actor] = await register(api, actor);
      id = await createCircuit(api, people.owner!);
      expect((await api.post(`/v1/circuits/${id}/shares`, { as: people.owner, json: { email: people.editor!.email, role: "editor" } })).status).toBe(201);
      expect((await api.post(`/v1/circuits/${id}/shares`, { as: people.owner, json: { email: people.viewer!.email, role: "viewer" } })).status).toBe(201);
      if (visibility === "public") expect((await api.patch(`/v1/circuits/${id}`, { as: people.owner, json: { visibility } })).status).toBe(200);
    });

    const rows = ACTORS.flatMap((actor) => Object.entries(EXPECTED[visibility][actor]).map(([action, status]) => ({ actor, action: action as Action, status })));
    it.each(rows)("$actor: $action -> $status", async ({ actor, action, status }) => {
      const { api } = context();
      const recipient = await register(api, "recipient");
      const reply = await attempt(api, action, id, people[actor], visibility, recipient);
      expect(reply.status, reply.text).toBe(status);
    });

    it("deleting: only the owner", async () => {
      const { api } = context();
      const path = `/v1/circuits/${id}`;
      const expected: [Actor, number][] = [["signed out", 401], ["stranger", visibility === "public" ? 403 : 404], ["viewer", 403], ["editor", 403], ["owner", 204]];
      for (const [actor, status] of expected) expect((await api.delete(path, { as: people[actor] })).status, actor).toBe(status);
      expect((await api.get(path, { as: people.owner })).status).toBe(404);
    });
  });

  it("answers a stranger's request for a private circuit exactly as for an id that doesn't exist", async () => {
    const { api } = context();
    const owner = await register(api, "Owner");
    const stranger = await register(api, "Stranger");
    const id = await createCircuit(api, owner);
    const hidden = await api.get(`/v1/circuits/${id}`, { as: stranger });
    const missing = await api.get(`/v1/circuits/${id.replace(/.$/, (c) => (c === "0" ? "1" : "0"))}`, { as: stranger });
    expect([hidden.status, missing.status]).toEqual([404, 404]);
    expect(hidden.body.detail.replace(id, "<id>")).toBe(missing.body.detail.replace(/"[^"]+"/, '"<id>"'));
  });

  it("lets editors change a circuit but never its owner or visibility through a replace", async () => {
    const { api } = context();
    const owner = await register(api, "Owner");
    const editor = await register(api, "Editor");
    const id = await createCircuit(api, owner);
    await api.post(`/v1/circuits/${id}/shares`, { as: owner, json: { email: editor.email, role: "editor" } });
    const replaced = await api.put(`/v1/circuits/${id}`, { as: editor, json: { ...halfAdderBody("Renamed by the editor") } });
    expect(replaced.body).toMatchObject({ name: "Renamed by the editor", owner: { id: owner.id }, visibility: "private" });
    const sneaky = await api.put(`/v1/circuits/${id}`, { as: editor, json: { ...halfAdderBody(), visibility: "public" } });
    expect(sneaky.status).toBe(422); // visibility isn't part of a circuit's content
  });
}
