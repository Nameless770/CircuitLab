import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseNetlist } from "@circuitlab/netlist";
import { describe, expect, it } from "vitest";
import type { Api, Person } from "../support/client";
import { createCircuit, halfAdderBody, register, type TestContext } from "../support/server";

const NETLISTS = join(__dirname, "..", "..", "..", "..", "examples", "netlists");
const netlist = (file: string): string => readFileSync(join(NETLISTS, file), "utf8");
const NETLIST_TYPE = { "Content-Type": "text/vnd.circuitlab.netlist" };

/** Every page of a list, following the `next` links. */
async function allPages(api: Api, path: string, as?: Person): Promise<{ names: string[]; pages: number }> {
  const names: string[] = [];
  let pages = 0;
  for (let next: string | null = path; next !== null; pages++) {
    const reply = await api.get(next, { as });
    expect(reply.status, reply.text).toBe(200);
    names.push(...reply.body.items.map((item: { name: string }) => item.name));
    next = reply.body.links.next;
    if (next !== null) expect(reply.headers.get("link")).toBe(`<${next}>; rel="next"`);
  }
  return { names, pages };
}

export function circuitsSuite(context: () => TestContext): void {
  describe("creating and reading circuits", () => {
    it("stores a JSON circuit, private to its creator, and gives it back exactly", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const created = await api.post("/v1/circuits", { as: ada, json: halfAdderBody() });
      expect(created.status).toBe(201);
      expect(created.headers.get("location")).toBe(`/v1/circuits/${created.body.id}`);
      expect(created.headers.get("etag")).toBe('"1"');
      expect(created.body).toMatchObject({ owner: { id: ada.id, displayName: "Ada" }, visibility: "private", version: 1 });
      const read = await api.get(`/v1/circuits/${created.body.id}`, { as: ada });
      expect(read.body.gates).toEqual(halfAdderBody().gates);
      expect(read.body.wires).toEqual(halfAdderBody().wires);
      expect(read.body.summary).toEqual({ gates: 6, wires: 6, inputs: ["A", "B"], outputs: ["S", "C"], feedbackLoop: null });
    });

    it("stores netlist files, plain or gzipped, and circuits with a feedback loop", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const plain = await api.post("/v1/circuits", { as: ada, body: netlist("full-adder.net"), headers: NETLIST_TYPE });
      expect(plain.body).toMatchObject({ name: "Full adder", summary: { inputs: ["A", "B", "Cin"] } });
      const gzipped = await api.post("/v1/circuits?name=ISCAS%20c17", { as: ada, body: gzipSync(netlist("c17.net")), headers: { ...NETLIST_TYPE, "Content-Encoding": "gzip" } });
      expect(gzipped.body.name).toBe("ISCAS c17");
      const latch = await api.post("/v1/circuits", { as: ada, body: netlist("sr-latch.net"), headers: NETLIST_TYPE });
      expect(latch.body.summary.feedbackLoop).toEqual(["q", "qbar", "q"]);
    });

    it("downloads a circuit as a netlist that reads back as the same circuit", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = (await api.post("/v1/circuits", { as: ada, body: netlist("c17.net"), headers: NETLIST_TYPE })).body.id;
      const download = await api.get(`/v1/circuits/${id}`, { as: ada, headers: { Accept: "text/vnd.circuitlab.netlist" } });
      expect(download.headers.get("content-type")).toBe("text/vnd.circuitlab.netlist; charset=utf-8");
      expect(download.headers.get("etag")).toBe('"1-netlist"');
      const original = parseNetlist(netlist("c17.net"));
      expect(parseNetlist(download.text)).toEqual({ ...original, name: original.name });
      expect((await api.get(`/v1/circuits/${id}`, { as: ada, headers: { Accept: "image/png" } })).status).toBe(406);
    });

    it("validates without storing on a dry run", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const dry = await api.post("/v1/circuits?dryRun=true", { as: ada, json: halfAdderBody() });
      expect(dry.status).toBe(200);
      expect(dry.body).toMatchObject({ valid: true, summary: { gates: 6 } });
      expect((await api.get("/v1/circuits", { as: ada })).body.items).toEqual([]);
    });

    it.each<[string, Record<string, string>, string | undefined, number, string]>([
      ["a circuit with problems", { "Content-Type": "application/json" }, JSON.stringify({ name: "x", gates: [{ id: "A", type: "INPUT" }, { id: "A", type: "NOT" }], wires: [] }), 422, "invalid-circuit"],
      ["broken JSON", { "Content-Type": "application/json" }, '{"name": "x", gates: }', 400, "malformed-body"],
      ["a broken netlist", NETLIST_TYPE, readFileSync(join(NETLISTS, "broken.net"), "utf8"), 422, "invalid-netlist"],
      ["plain text", { "Content-Type": "text/plain" }, "A = INPUT", 415, "unsupported-media-type"],
      ["a body over 5 MB", { "Content-Type": "application/json" }, JSON.stringify({ name: "x".repeat(6 * 1024 * 1024) }), 413, "content-too-large"],
    ])("refuses %s", async (_, headers, body, status, code) => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const reply = await api.post("/v1/circuits", { as: ada, headers, ...(body !== undefined && { body }) });
      expect([reply.status, reply.body.code]).toEqual([status, code]);
    });

    it("treats an id that isn't a UUID as unknown", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      expect((await api.get("/v1/circuits/not-a-uuid", { as: ada })).status).toBe(404);
    });
  });

  describe("changing circuits safely", () => {
    it("answers 304 when the client's copy is current", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const reply = await api.get(`/v1/circuits/${id}`, { as: ada, headers: { "If-None-Match": '"1"' } });
      expect(reply.status).toBe(304);
      expect(reply.text).toBe("");
    });

    it("refuses an edit based on an old version (412) instead of overwriting someone's change", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const first = await api.patch(`/v1/circuits/${id}`, { as: ada, json: { name: "First" }, headers: { "If-Match": '"1"' } });
      expect([first.status, first.headers.get("etag")]).toEqual([200, '"2"']);
      const stale = await api.put(`/v1/circuits/${id}`, { as: ada, json: halfAdderBody("Second"), headers: { "If-Match": '"1"' } });
      expect([stale.status, stale.body.code]).toEqual([412, "precondition-failed"]);
      expect((await api.delete(`/v1/circuits/${id}`, { as: ada, headers: { "If-Match": '"1"' } })).status).toBe(412);
      expect((await api.get(`/v1/circuits/${id}`, { as: ada })).body.name).toBe("First");
    });

    it("applies an edit without If-Match to whatever is current (last write wins)", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      await api.patch(`/v1/circuits/${id}`, { as: ada, json: { name: "One" } });
      const replaced = await api.put(`/v1/circuits/${id}`, { as: ada, json: halfAdderBody("Two") });
      expect(replaced.body).toMatchObject({ name: "Two", version: 3 });
    });

    it("applies concurrent edits one after another: with If-Match exactly one wins, without it all do", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const guarded = await Promise.all(
        Array.from({ length: 5 }, (_, k) => api.patch(`/v1/circuits/${id}`, { as: ada, json: { description: `guarded ${k}` }, headers: { "If-Match": '"1"' } })),
      );
      expect(guarded.map((reply) => reply.status).sort()).toEqual([200, 412, 412, 412, 412]);
      const unguarded = await Promise.all(Array.from({ length: 5 }, (_, k) => api.patch(`/v1/circuits/${id}`, { as: ada, json: { description: `free ${k}` } })));
      expect(unguarded.map((reply) => reply.status)).toEqual([200, 200, 200, 200, 200]);
      expect((await api.get(`/v1/circuits/${id}`, { as: ada })).body.version).toBe(7);
    });

    it("deletes", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      expect((await api.delete(`/v1/circuits/${id}`, { as: ada, headers: { "If-Match": '"1"' } })).status).toBe(204);
      expect((await api.get(`/v1/circuits/${id}`, { as: ada })).status).toBe(404);
      expect((await api.delete(`/v1/circuits/${id}`, { as: ada })).status).toBe(404);
    });
  });

  describe("listing", () => {
    it("pages through someone's circuits with cursors, each exactly once, in every sort order", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const names = ["delta", "alpha", "echo", "charlie", "bravo"];
      for (const name of names) await createCircuit(api, ada, halfAdderBody(name));
      const newest = await allPages(api, "/v1/circuits?limit=2", ada);
      expect(newest).toEqual({ names: [...names].reverse(), pages: 3 });
      expect((await allPages(api, "/v1/circuits?limit=2&sort=name", ada)).names).toEqual([...names].sort());
      expect((await allPages(api, "/v1/circuits?limit=3&sort=-updatedAt", ada)).names).toHaveLength(5);
    });

    it("keeps each list to its scope: mine, shared with me, public", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const bob = await register(api, "Bob");
      const mine = await createCircuit(api, bob, halfAdderBody("Bob's own"));
      const shared = await createCircuit(api, ada, halfAdderBody("Shared with Bob"));
      const published = await createCircuit(api, ada, halfAdderBody(`Public ${ada.id}`));
      await createCircuit(api, ada, halfAdderBody("Ada's secret"));
      await api.post(`/v1/circuits/${shared}/shares`, { as: ada, json: { email: bob.email, role: "viewer" } });
      await api.patch(`/v1/circuits/${published}`, { as: ada, json: { visibility: "public" } });

      const ids = async (path: string, as?: Person): Promise<string[]> => (await api.get(path, { as })).body.items.map((item: { id: string }) => item.id);
      expect(await ids("/v1/circuits", bob)).toEqual([mine]); // signed in: owned by default
      expect(await ids("/v1/circuits?scope=shared", bob)).toEqual([shared]);
      const everyone = await ids(`/v1/circuits?scope=public&q=${encodeURIComponent(ada.id)}`, bob);
      expect(everyone).toEqual([published]);
      expect(await ids(`/v1/circuits?q=${encodeURIComponent(ada.id)}`)).toEqual([published]); // signed out: public by default
      expect((await api.get("/v1/circuits?scope=shared")).status).toBe(401);
    });

    it("searches names case-insensitively, with % and _ matching themselves", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      for (const name of ["Adder 100%", "Adder 1000", "adder_x", "adderAx", "Multiplexer"]) await createCircuit(api, ada, halfAdderBody(name));
      const search = async (q: string): Promise<string[]> =>
        (await api.get(`/v1/circuits?sort=name&q=${encodeURIComponent(q)}`, { as: ada })).body.items.map((item: { name: string }) => item.name);
      expect(await search("ADDER")).toEqual(["Adder 100%", "Adder 1000", "adderAx", "adder_x"]);
      expect(await search("100%")).toEqual(["Adder 100%"]);
      expect(await search("_x")).toEqual(["adder_x"]);
    });

    it("refuses a forged cursor", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const forged = Buffer.from(JSON.stringify([1, "-createdAt", "not a time", "x"])).toString("base64url");
      const reply = await api.get(`/v1/circuits?cursor=${forged}`, { as: ada });
      expect([reply.status, reply.body.issues?.[0]?.code]).toEqual([400, "INVALID_CURSOR"]);
    });
  });
}
