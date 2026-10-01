import type { UserRecord } from "@circuitlab/api-contract";
import type { PrismaClient } from "@circuitlab/database";
import { Injectable } from "@nestjs/common";
import { UsersRepository, type NewUser, type UserWithPassword } from "../auth/users.repository";
import { Clock } from "../common/clock";
import { UUID } from "./prisma-circuits.repository";
import { PrismaService } from "./prisma.service";

/** Every column but the password hash, which only signing in reads. */
const PUBLIC_COLUMNS = { id: true, email: true, displayName: true, createdAt: true } as const;

/** The `users` table, through Prisma Client. */
@Injectable()
export class PrismaUsersRepository extends UsersRepository {
  constructor(
    private readonly database: PrismaService,
    private readonly clock: Clock,
  ) {
    super();
  }

  private get prisma(): PrismaClient {
    return this.database.client;
  }

  async create(user: NewUser): Promise<UserRecord | undefined> {
    try {
      const now = this.clock.now();
      return await this.prisma.user.create({ data: { ...user, createdAt: now, updatedAt: now }, select: PUBLIC_COLUMNS });
    } catch (error) {
      // P2002: a unique constraint refused the row. The only one on users is the email address.
      if ((error as { code?: unknown }).code === "P2002") return undefined;
      throw error;
    }
  }

  async findByEmail(email: string): Promise<UserWithPassword | undefined> {
    return (await this.prisma.user.findUnique({ where: { email }, select: { ...PUBLIC_COLUMNS, passwordHash: true } })) ?? undefined;
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    if (!UUID.test(id)) return undefined;
    return (await this.prisma.user.findUnique({ where: { id }, select: PUBLIC_COLUMNS })) ?? undefined;
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { passwordHash, updatedAt: this.clock.now() } });
  }
}
