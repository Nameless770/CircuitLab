import { ApiError, circuitPage, ifMatchPasses, summarizeCircuit, unauthenticated } from "@circuitlab/api-contract";
import type { CircuitInput, CircuitMetadataPatch, CircuitPage, CircuitRecord, ListCircuitsQuery } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import type { AuthUser } from "../auth/auth-user";
import { accessOf, allows, denied, type AccessFacts, type CircuitAccess, type CircuitAction } from "./circuit-access";
import { CircuitsRepository, type CircuitDraft } from "./circuits.repository";

/** Circuit use cases: HTTP-free, so the same rules hold whatever calls them. */
@Injectable()
export class CircuitsService {
  constructor(private readonly repository: CircuitsRepository) {}

  /**
   * One page of the caller's circuits, the ones shared with them, or the public ones. Without a
   * `scope`, signed-in callers get their own circuits and everyone else the public ones.
   *
   * @throws ApiError `unauthenticated` (401) for `owned` or `shared` without a token
   */
  async list(query: ListCircuitsQuery, user: AuthUser | undefined, basePath: string): Promise<CircuitPage> {
    const scope = query.scope ?? (user === undefined ? "public" : "owned");
    if (scope !== "public" && user === undefined) throw unauthenticated(`scope=${scope} lists your circuits: sign in first, or use scope=public.`);
    // One circuit more than a page: if it exists, there is a next page. Cheaper than counting.
    const fetched = await this.repository.list({ ...query, scope, userId: user?.id, limit: query.limit + 1 });
    return circuitPage(fetched, { ...query, scope }, basePath);
  }

  /**
   * Checks that `user` may do `action` to the circuit.
   * @throws ApiError `not-found` (404) if they may not see it, `forbidden` (403) if they may see it but not do this
   */
  async authorize(id: string, user: AuthUser | undefined, action: CircuitAction): Promise<{ readonly facts: AccessFacts; readonly access: CircuitAccess }> {
    const facts = await this.repository.accessFacts(id, user?.id);
    const access = facts === undefined ? undefined : accessOf(facts, user?.id);
    if (facts === undefined || access === undefined) throw notFound(id);
    if (!allows(access, action)) throw denied(access, action);
    return { facts, access };
  }

  /** @throws ApiError `not-found` (404) */
  async get(id: string, user: AuthUser | undefined): Promise<CircuitRecord> {
    await this.authorize(id, user, "read");
    const record = await this.repository.find(id);
    if (record === undefined) throw notFound(id); // deleted in the meantime
    return record;
  }

  /** A new circuit belongs to its creator and is private. */
  create(input: CircuitInput, user: AuthUser): Promise<CircuitRecord> {
    return this.repository.create(draft(input), user.id);
  }

  /** For the owner and editors. @throws ApiError `not-found`, `forbidden`, or `precondition-failed` when `ifMatch` names an old version */
  replace(id: string, input: CircuitInput, ifMatch: string | undefined, user: AuthUser): Promise<CircuitRecord> {
    return this.write(id, user, "edit", ifMatch, (version) => this.repository.replace(id, draft(input), version));
  }

  /**
   * Renaming and describing are for the owner and editors; changing who can see the circuit is
   * for the owner alone.
   *
   * @throws ApiError `not-found`, `forbidden`, or `precondition-failed`
   */
  updateMetadata(id: string, patch: CircuitMetadataPatch, ifMatch: string | undefined, user: AuthUser): Promise<CircuitRecord> {
    const action = patch.visibility === undefined ? "edit" : "manage";
    return this.write(id, user, action, ifMatch, (version) => this.repository.updateMetadata(id, patch, version));
  }

  /** For the owner. @throws ApiError `not-found`, `forbidden`, or `precondition-failed` */
  async delete(id: string, ifMatch: string | undefined, user: AuthUser): Promise<void> {
    await this.write(id, user, "manage", ifMatch, async (version) => ((await this.repository.delete(id, version)) ? true : undefined));
  }

  /**
   * Applies a write the user is allowed to make, with or without a version condition.
   *
   * With If-Match, the client says which version it edited. If that isn't the current one, or
   * someone saves between our check and our write, the answer is 412 rather than silently undoing
   * the other person's change: the write itself only applies `WHERE version = <that version>`.
   *
   * Without If-Match (or with `*`), the client accepts "last write wins". The write then has no
   * version condition at all, so it can't lose a race; the database applies concurrent writes
   * one after another.
   */
  private async write<T>(
    id: string,
    user: AuthUser,
    action: CircuitAction,
    ifMatch: string | undefined,
    apply: (expectedVersion: number | undefined) => Promise<T | undefined>,
  ): Promise<T> {
    const { facts } = await this.authorize(id, user, action);
    let expected: number | undefined;
    if (ifMatch !== undefined && ifMatch.trim() !== "*") {
      if (!ifMatchPasses(ifMatch, facts.version)) throw changedSince(facts.version);
      expected = facts.version;
    }
    const result = await apply(expected);
    if (result !== undefined) return result;
    // Changed or deleted between the check and the write.
    const now = await this.repository.accessFacts(id, user.id);
    if (now === undefined || expected === undefined) throw notFound(id);
    throw changedSince(now.version);
  }
}

/** The summary is computed once, when a circuit is written, and stored with it. */
function draft(input: CircuitInput): CircuitDraft {
  return { ...input, summary: summarizeCircuit(input) };
}

/** The same answer for "doesn't exist" and "you may not see it", so ids can't be probed. */
function notFound(id: string): ApiError {
  return new ApiError("not-found", `No circuit has the id ${JSON.stringify(id.slice(0, 64))}, or you may not see it.`);
}

function changedSince(version: number): ApiError {
  return new ApiError(
    "precondition-failed",
    `The circuit has changed since you loaded it; it is now at version ${version}. Load it again and reapply your change.`,
  );
}
