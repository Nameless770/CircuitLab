import type { PrismaClient } from "@circuitlab/database";
import { Injectable } from "@nestjs/common";
import { SessionsRepository } from "../auth/sessions.repository";
import { UUID } from "./prisma-circuits.repository";
import { PrismaService } from "./prisma.service";

/** The `sessions` table, through Prisma Client. */
@Injectable()
export class PrismaSessionsRepository extends SessionsRepository {
  constructor(private readonly database: PrismaService) {
    super();
  }

  private get prisma(): PrismaClient {
    return this.database.client;
  }

  async create(userId: string, secretHash: Buffer, now: Date, expiresAt: Date): Promise<string> {
    const session = await this.prisma.session.create({
      data: { userId, secretHash: bytes(secretHash), createdAt: now, refreshedAt: now, expiresAt },
      select: { id: true },
    });
    return session.id;
  }

  /**
   * queries.sql: rotate_session. One UPDATE that both checks and replaces the secret, so of two
   * refreshes racing with the same token only one can succeed.
   */
  async rotate(sessionId: string, secretHash: Buffer, newSecretHash: Buffer, now: Date, expiresAt: Date): Promise<string | undefined> {
    if (!UUID.test(sessionId)) return undefined;
    const [session] = await this.prisma.session.updateManyAndReturn({
      where: { id: sessionId, secretHash: bytes(secretHash), expiresAt: { gt: now } },
      data: { secretHash: bytes(newSecretHash), refreshedAt: now, expiresAt },
      select: { userId: true },
    });
    return session?.userId;
  }

  async delete(sessionId: string): Promise<void> {
    if (!UUID.test(sessionId)) return;
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }
}

/** Prisma takes bytes as a plain Uint8Array over an ArrayBuffer; a Node Buffer may sit on a shared pool. */
function bytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer);
}
