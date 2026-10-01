import { describe, expect, it } from "vitest";
import { createCircuit, register, type TestContext } from "../support/server";

export function sharingSuite(context: () => TestContext): void {
  describe("sharing", () => {
    it("shares by email address; sharing again changes the role (201, then 200)", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const bob = await register(api, "Bob");
      const id = await createCircuit(api, ada);
      const first = await api.post(`/v1/circuits/${id}/shares`, { as: ada, json: { email: bob.email.toUpperCase(), role: "viewer" } });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ user: { id: bob.id, displayName: "Bob", email: bob.email }, role: "viewer" });
      const again = await api.post(`/v1/circuits/${id}/shares`, { as: ada, json: { email: bob.email, role: "editor" } });
      expect([again.status, again.body.role, again.body.createdAt]).toEqual([200, "editor", first.body.createdAt]);
      const list = await api.get(`/v1/circuits/${id}/shares`, { as: ada });
      expect(list.body.items).toEqual([again.body]);
    });

    it("refuses an address without an account, and the owner's own", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const unknown = await api.post(`/v1/circuits/${id}/shares`, { as: ada, json: { email: "no.such.person@example.com", role: "viewer" } });
      expect([unknown.status, unknown.body.issues?.[0]?.code]).toEqual([422, "UNKNOWN_USER"]);
      const self = await api.post(`/v1/circuits/${id}/shares`, { as: ada, json: { email: ada.email, role: "editor" } });
      expect([self.status, self.body.issues?.[0]?.code]).toEqual([422, "OWNER"]);
    });

    it("lets the recipient leave, and the owner remove anyone", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const bob = await register(api, "Bob");
      const carol = await register(api, "Carol");
      const id = await createCircuit(api, ada);
      for (const person of [bob, carol]) await api.post(`/v1/circuits/${id}/shares`, { as: ada, json: { email: person.email, role: "viewer" } });
      expect((await api.delete(`/v1/circuits/${id}/shares/${carol.id}`, { as: bob })).status).toBe(403); // not his to remove
      expect((await api.delete(`/v1/circuits/${id}/shares/${bob.id}`, { as: bob })).status).toBe(204); // he leaves
      expect((await api.get(`/v1/circuits/${id}`, { as: bob })).status).toBe(404);
      expect((await api.delete(`/v1/circuits/${id}/shares/${carol.id}`, { as: ada })).status).toBe(204);
      expect((await api.delete(`/v1/circuits/${id}/shares/${carol.id}`, { as: ada })).status).toBe(404); // already gone
      expect((await api.get(`/v1/circuits/${id}/shares`, { as: ada })).body.items).toEqual([]);
    });

    it("takes a deleted circuit off everyone's shared list", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const bob = await register(api, "Bob");
      const id = await createCircuit(api, ada);
      await api.post(`/v1/circuits/${id}/shares`, { as: ada, json: { email: bob.email, role: "editor" } });
      expect((await api.get("/v1/circuits?scope=shared", { as: bob })).body.items).toHaveLength(1);
      await api.delete(`/v1/circuits/${id}`, { as: ada });
      expect((await api.get("/v1/circuits?scope=shared", { as: bob })).body.items).toEqual([]);
    });
  });
}
