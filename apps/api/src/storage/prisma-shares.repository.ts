import type { ShareRecord, ShareRole } from "@circuitlab/api-contract";
import type { PrismaClient } from "@circuitlab/database";
import { Injectable } from "@nestjs/common";
import { SharesRepository } from "../circuits/shares.repository";
import { Clock } from "../common/clock";
import { UUID } from "./prisma-circuits.repository";
import { PrismaService } from "./prisma.service";

interface UpsertRow {
  user_id: string;
  display_name: string;
  email: string;
  role: ShareRole;
  created_at: Date;
  created: boolean;
}

/** The `circuit_shares` table, through Prisma Client. */
@Injectable()
export class PrismaSharesRepository extends SharesRepository {
  constructor(
    private readonly database: PrismaService,
    private readonly clock: Clock,
  ) {
    super();
  }

  private get prisma(): PrismaClient {
    return this.database.client;
  }

  async list(circuitId: string): Promise<readonly ShareRecord[]> {
    if (!UUID.test(circuitId)) return [];
    const rows = await this.prisma.circuitShare.findMany({
      where: { circuitId },
      orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
      select: { role: true, createdAt: true, user: { select: { id: true, displayName: true, email: true } } },
    });
    return rows.map((row) => ({ user: row.user, role: row.role, createdAt: row.createdAt }));
  }

  /**
   * queries.sql: share_circuit. SQL because Prisma's upsert can't say whether it inserted or
   * updated, and the API answers 201 or 200 accordingly. A row just inserted has xmax = 0; one
   * updated by ON CONFLICT has the updating transaction's id there.
   */
  async upsert(circuitId: string, userId: string, role: ShareRole): Promise<{ readonly share: ShareRecord; readonly created: boolean }> {
    const now = this.clock.now();
    const [row] = await this.prisma.$queryRaw<UpsertRow[]>`
      WITH s AS (
        INSERT INTO circuit_shares (circuit_id, user_id, role, created_at, updated_at)
        VALUES (${circuitId}::uuid, ${userId}::uuid, ${role}::share_role, ${now}, ${now})
        ON CONFLICT (circuit_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = EXCLUDED.updated_at
        RETURNING user_id, role, created_at, (xmax = 0) AS created
      )
      SELECT s.user_id, u.display_name, u.email, s.role::text AS role, s.created_at, s.created
      FROM s JOIN users AS u ON u.id = s.user_id`;
    if (row === undefined) throw new Error("INSERT ... RETURNING returned no row");
    return {
      share: { user: { id: row.user_id, displayName: row.display_name, email: row.email }, role: row.role, createdAt: row.created_at },
      created: row.created,
    };
  }

  async remove(circuitId: string, userId: string): Promise<boolean> {
    if (!UUID.test(circuitId) || !UUID.test(userId)) return false;
    const { count } = await this.prisma.circuitShare.deleteMany({ where: { circuitId, userId } });
    return count === 1;
  }
}
