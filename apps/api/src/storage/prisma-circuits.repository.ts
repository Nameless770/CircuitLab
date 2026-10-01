import { ApiError } from "@circuitlab/api-contract";
import type {
  CircuitCursor,
  CircuitHeader,
  CircuitMetadataPatch,
  CircuitRecord,
  CircuitSort,
  CircuitSummary,
  ShareRole,
  UserSummary,
  Visibility,
} from "@circuitlab/api-contract";
import { Prisma, type GateRow, type PrismaClient, type WireRow } from "@circuitlab/database";
import type { Gate, Wire } from "@circuitlab/engine";
import { Injectable } from "@nestjs/common";
import type { AccessFacts } from "../circuits/circuit-access";
import { CircuitsRepository, type CircuitDraft, type CircuitQuery } from "../circuits/circuits.repository";
import { PrismaService } from "./prisma.service";

/** Ids are UUIDs. Anything else can't name a stored row, and PostgreSQL would reject it as a uuid. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The nil UUID: no account has it (ids are UUIDv7), so "shared with nobody" can be asked like any user. */
const NOBODY = "00000000-0000-0000-0000-000000000000";

/** One list order per sort, matching an index (see docs/database-design.md). */
const ORDER_BY: Readonly<Record<CircuitSort, Prisma.Sql>> = {
  "-createdAt": Prisma.sql`ORDER BY c.created_at DESC, c.id DESC`,
  "-updatedAt": Prisma.sql`ORDER BY c.updated_at DESC, c.id DESC`,
  name: Prisma.sql`ORDER BY c.name, c.id`,
};

interface HeaderRow {
  id: string;
  name: string;
  description: string | null;
  version: number;
  visibility: Visibility;
  owner_id: string;
  owner_name: string;
  gate_count: number;
  wire_count: number;
  input_keys: string[];
  output_keys: string[];
  feedback_loop: string[];
  created_at: Date;
  updated_at: Date;
}

/**
 * Circuits in PostgreSQL, through Prisma Client. A circuit is one `circuits` row plus its `gates`
 * and `wires` rows; every write touches them in a single transaction.
 */
@Injectable()
export class PrismaCircuitsRepository extends CircuitsRepository {
  constructor(private readonly database: PrismaService) {
    super();
  }

  private get prisma(): PrismaClient {
    return this.database.client;
  }

  /**
   * Cursor pagination needs a row comparison, `(created_at, id) < ($time, $id)`, which PostgreSQL
   * turns into a single index range scan. Prisma's query API can only say it as
   * `created_at < $time OR (created_at = $time AND id < $id)`, which PostgreSQL can't use to start
   * the scan at the cursor, so every page would reread the ones before it. This one query is
   * therefore SQL: still fully parameterized by Prisma's tagged template.
   */
  async list({ limit, sort, scope, userId, cursor, q }: CircuitQuery): Promise<readonly CircuitHeader[]> {
    const conditions: Prisma.Sql[] = [];
    let from = Prisma.sql`circuits AS c`;
    switch (scope) {
      case "owned":
        conditions.push(Prisma.sql`c.owner_id = ${userId ?? NOBODY}::uuid`);
        break;
      case "shared":
        from = Prisma.sql`circuit_shares AS s JOIN circuits AS c ON c.id = s.circuit_id`;
        conditions.push(Prisma.sql`s.user_id = ${userId ?? NOBODY}::uuid`);
        break;
      case "public":
        conditions.push(Prisma.sql`c.visibility = 'public'`);
        break;
    }
    if (q !== undefined) conditions.push(Prisma.sql`c.name ILIKE ${`%${escapeLike(q)}%`}`);
    if (cursor !== undefined) conditions.push(afterCursor(cursor));
    const rows = await this.prisma.$queryRaw<HeaderRow[]>`
      SELECT c.id, c.name, c.description, c.version, c.visibility::text AS visibility, c.owner_id, u.display_name AS owner_name,
             c.gate_count, c.wire_count, c.input_keys, c.output_keys, c.feedback_loop, c.created_at, c.updated_at
      FROM ${from} JOIN users AS u ON u.id = c.owner_id
      WHERE ${Prisma.join(conditions, " AND ")} ${ORDER_BY[sort]} LIMIT ${limit}`;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      owner: { id: row.owner_id, displayName: row.owner_name },
      visibility: row.visibility,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      summary: summary(row.gate_count, row.wire_count, row.input_keys, row.output_keys, row.feedback_loop),
    }));
  }

  async find(id: string): Promise<CircuitRecord | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.prisma.circuit.findUnique({ where: { id }, include: WITH_PARTS });
    return row === null ? undefined : toRecord(row);
  }

  /** queries.sql: access_of. One indexed lookup, plus the caller's share by primary key. */
  async accessFacts(id: string, userId: string | undefined): Promise<AccessFacts | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.prisma.circuit.findUnique({
      where: { id },
      select: {
        ownerId: true,
        visibility: true,
        version: true,
        shares: { where: { userId: userId !== undefined && UUID.test(userId) ? userId : NOBODY }, select: { role: true } },
      },
    });
    if (row === null || row.ownerId === null) return undefined; // ownerless circuits predate accounts: nobody's
    return { ownerId: row.ownerId, visibility: row.visibility, version: row.version, sharedRole: row.shares[0]?.role as ShareRole | undefined };
  }

  async create(draft: CircuitDraft, ownerId: string): Promise<CircuitRecord> {
    const row = await this.prisma.$transaction(async (tx) => {
      const circuit = await tx.circuit.create({
        data: { ...columns(draft), ownerId, gates: { createMany: { data: gateRows(draft) } } },
        include: { owner: OWNER },
      });
      await tx.wire.createMany({ data: wireRows(circuit.id, draft) });
      return circuit;
    });
    if (row.owner === null) throw new Error(`Circuit ${row.id} was stored without its owner`); // can't happen: ownerId was just set
    return { ...header(row, row.owner), gates: draft.gates, wires: draft.wires };
  }

  async replace(id: string, draft: CircuitDraft, expectedVersion?: number): Promise<CircuitRecord | undefined> {
    if (!UUID.test(id)) return undefined;
    const result = await this.prisma.$transaction(async (tx) => {
      // With an expected version, applies only if the circuit is still at it. Either way the UPDATE
      // locks the row until the transaction ends, so concurrent replacements run one after another.
      const [updated] = await tx.circuit.updateManyAndReturn({
        where: { id, version: expectedVersion }, // an undefined version is no condition at all
        data: { ...columns(draft), version: { increment: 1 }, updatedAt: new Date() },
      });
      if (updated === undefined) return undefined;
      await tx.gate.deleteMany({ where: { circuitId: id } }); // the wires go with them
      await tx.gate.createMany({ data: gateRows(draft).map((gate) => ({ ...gate, circuitId: id })) });
      await tx.wire.createMany({ data: wireRows(id, draft) });
      const owner = await tx.user.findUniqueOrThrow({ where: { id: updated.ownerId ?? NOBODY }, ...OWNER });
      return { updated, owner };
    });
    return result === undefined ? undefined : { ...header(result.updated, result.owner), gates: draft.gates, wires: draft.wires };
  }

  async updateMetadata(id: string, patch: CircuitMetadataPatch, expectedVersion?: number): Promise<CircuitRecord | undefined> {
    if (!UUID.test(id)) return undefined;
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.circuit.updateMany({
        where: { id, version: expectedVersion },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.visibility !== undefined && { visibility: patch.visibility }),
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (count === 0) return undefined;
      const row = await tx.circuit.findUnique({ where: { id }, include: WITH_PARTS });
      return row === null ? undefined : toRecord(row);
    });
  }

  async delete(id: string, expectedVersion?: number): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const { count } = await this.prisma.circuit.deleteMany({ where: { id, version: expectedVersion } });
    return count === 1;
  }
}

const OWNER = { select: { id: true, displayName: true } } as const;

const WITH_PARTS = {
  owner: OWNER,
  gates: { orderBy: { position: "asc" } },
  wires: { orderBy: { position: "asc" } },
} as const satisfies Prisma.CircuitInclude;

type CircuitWithParts = Prisma.CircuitGetPayload<{ include: typeof WITH_PARTS }>;
type CircuitColumns = Omit<CircuitWithParts, "owner" | "gates" | "wires">;

function columns(draft: CircuitDraft) {
  const { gates, wires, inputs, outputs, feedbackLoop } = draft.summary;
  return {
    name: draft.name,
    description: draft.description ?? null,
    gateCount: gates,
    wireCount: wires,
    inputKeys: [...inputs],
    outputKeys: [...outputs],
    feedbackLoop: [...(feedbackLoop ?? [])], // the column holds an empty array when there is no loop
  };
}

/** Gate rows, in declaration order: `position` keeps that order. */
function gateRows(draft: CircuitDraft) {
  return draft.gates.map((gate, position) => ({
    key: gate.id,
    position,
    type: gate.type,
    label: gate.label ?? null,
    constValue: gate.type === "CONST" ? gate.value : null,
  }));
}

function wireRows(circuitId: string, draft: CircuitDraft) {
  return draft.wires.map((wire, position) => ({
    circuitId,
    sourceKey: wire.from,
    targetKey: wire.to,
    targetPin: wire.toPin,
    position,
    key: wire.id ?? null,
  }));
}

function header(row: CircuitColumns, owner: UserSummary): CircuitHeader {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    owner: { id: owner.id, displayName: owner.displayName },
    visibility: row.visibility,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    summary: summary(row.gateCount, row.wireCount, row.inputKeys, row.outputKeys, row.feedbackLoop),
  };
}

/** Undefined for a circuit stored before accounts existed: it has no owner, so nobody may see it. */
function toRecord(row: CircuitWithParts): CircuitRecord | undefined {
  if (row.owner === null) return undefined;
  return { ...header(row, row.owner), gates: row.gates.map(toGate), wires: row.wires.map(toWire) };
}

function summary(gates: number, wires: number, inputs: string[], outputs: string[], feedbackLoop: string[]): CircuitSummary {
  return { gates, wires, inputs, outputs, feedbackLoop: feedbackLoop.length === 0 ? null : feedbackLoop };
}

function toGate(row: GateRow): Gate {
  const label = row.label === null ? {} : { label: row.label };
  if (row.type === "CONST") return { id: row.key, type: "CONST", value: row.constValue === 1 ? 1 : 0, ...label };
  return { id: row.key, type: row.type, ...label } as Gate;
}

function toWire(row: WireRow): Wire {
  return { ...(row.key !== null && { id: row.key }), from: row.sourceKey, to: row.targetKey, toPin: row.targetPin };
}

/** "After the cursor" in the list order, as a row comparison the matching index can serve. */
function afterCursor(cursor: CircuitCursor): Prisma.Sql {
  const time = new Date(cursor.value);
  if (!UUID.test(cursor.id) || (cursor.sort !== "name" && Number.isNaN(time.getTime()))) {
    // Only a forged cursor gets here: one made by this API always holds a real id and time.
    throw new ApiError("invalid-request", "The cursor is not valid.", {
      issues: [{ code: "INVALID_CURSOR", message: "is not a cursor from this API", parameter: "cursor" }],
    });
  }
  switch (cursor.sort) {
    case "-createdAt":
      return Prisma.sql`(c.created_at, c.id) < (${time}, ${cursor.id}::uuid)`;
    case "-updatedAt":
      return Prisma.sql`(c.updated_at, c.id) < (${time}, ${cursor.id}::uuid)`;
    case "name":
      return Prisma.sql`(c.name, c.id) > (${cursor.value}, ${cursor.id}::uuid)`;
  }
}

/** Makes `%`, `_`, and `\` in a search text match themselves in ILIKE instead of acting as wildcards. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}
