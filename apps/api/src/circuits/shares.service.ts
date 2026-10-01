import { ApiError, normalizeEmail, shareResource } from "@circuitlab/api-contract";
import type { ShareList, ShareRequest, ShareResource } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import type { AuthUser } from "../auth/auth-user";
import { UsersRepository } from "../auth/users.repository";
import { CircuitsService } from "./circuits.service";
import { SharesRepository } from "./shares.repository";

/** Sharing a circuit with other accounts. Only the owner manages shares; anyone may leave one. */
@Injectable()
export class SharesService {
  constructor(
    private readonly circuits: CircuitsService,
    private readonly shares: SharesRepository,
    private readonly users: UsersRepository,
  ) {}

  /** @throws ApiError `not-found` (404) or `forbidden` (403) */
  async list(circuitId: string, user: AuthUser): Promise<ShareList> {
    await this.circuits.authorize(circuitId, user, "manage");
    return { items: (await this.shares.list(circuitId)).map(shareResource) };
  }

  /** @throws ApiError `not-found`, `forbidden`, or `invalid-fields` (422) for an unknown address or the owner's own */
  async share(circuitId: string, user: AuthUser, request: ShareRequest): Promise<{ readonly share: ShareResource; readonly created: boolean }> {
    await this.circuits.authorize(circuitId, user, "manage");
    const recipient = await this.users.findByEmail(normalizeEmail(request.email));
    if (recipient === undefined) {
      throw new ApiError("invalid-fields", "No account uses this email address. They need to register first.", {
        issues: [{ code: "UNKNOWN_USER", message: "has no account", pointer: "/email" }],
      });
    }
    if (recipient.id === user.id) {
      throw new ApiError("invalid-fields", "You own this circuit, so you have every right to it already.", {
        issues: [{ code: "OWNER", message: "is the circuit's owner", pointer: "/email" }],
      });
    }
    const { share, created } = await this.shares.upsert(circuitId, recipient.id, request.role);
    return { share: shareResource(share), created };
  }

  /**
   * The owner may remove anyone's access; anyone may remove their own (leave a circuit shared
   * with them).
   *
   * @throws ApiError `not-found` (404) if the circuit isn't visible or not shared with that user, `forbidden` (403)
   */
  async remove(circuitId: string, user: AuthUser, userId: string): Promise<void> {
    await this.circuits.authorize(circuitId, user, userId === user.id ? "read" : "manage");
    if (!(await this.shares.remove(circuitId, userId))) {
      throw new ApiError("not-found", "The circuit isn't shared with that user.");
    }
  }
}
