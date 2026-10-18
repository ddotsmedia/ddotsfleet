import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { createTenantRoles, ensurePermissionCatalog } from "../database/catalog.js";
import { generateToken, hashToken } from "../common/security.js";
import { MAIL_TRANSPORT, type MailTransport } from "../common/mail.js";
import type { TenantAccess } from "../access/access.service.js";
import type { RoleCode } from "../generated/prisma/client.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreateTenantInput {
  name: string;
  slug: string;
}

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAIL_TRANSPORT) private readonly mail: MailTransport,
  ) {}

  /** Creates the tenant, its eight roles and the caller as active company_admin, atomically. */
  async createTenant(userId: string, input: CreateTenantInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const permIds = await ensurePermissionCatalog(tx);
        const tenant = await tx.tenant.create({
          data: { name: input.name, slug: input.slug, createdBy: userId },
          select: { id: true, name: true, slug: true, status: true },
        });
        const roleIds = await createTenantRoles(tx, tenant.id, permIds);
        const membership = await tx.tenantMembership.create({
          data: {
            tenantId: tenant.id,
            userId,
            status: "active",
            joinedAt: new Date(),
            createdBy: userId,
          },
        });
        await tx.grant.create({
          data: {
            tenantId: tenant.id,
            membershipId: membership.id,
            roleId: roleIds.get("company_admin")!,
            grantedBy: userId,
          },
        });
        return tenant;
      });
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "P2002") throw new ConflictException("slug_taken");
      throw e;
    }
  }

  async getTenant(access: TenantAccess) {
    return this.prisma.tenant.findUniqueOrThrow({
      where: { id: access.tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        country: true,
        timezone: true,
        currency: true,
        status: true,
      },
    });
  }

  /** Bounded list; cursor pagination is added with the first large-list feature. */
  async listMembers(tenantId: string) {
    const rows = await this.prisma.tenantMembership.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: {
        id: true,
        status: true,
        joinedAt: true,
        user: { select: { id: true, email: true, displayName: true } },
        grants: { select: { role: { select: { roleCode: true } } } },
      },
    });
    return rows.map((m) => ({
      membershipId: m.id,
      status: m.status,
      joinedAt: m.joinedAt,
      user: m.user,
      roleCodes: m.grants.map((g) => g.role.roleCode),
    }));
  }

  /** The tenant comes from the verified access context, never from the request body. */
  async createInvitation(access: TenantAccess, input: { email: string; roleCode: RoleCode }) {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const invitation = await this.prisma.invitation.create({
      data: {
        tenantId: access.tenantId,
        email: input.email,
        roleCode: input.roleCode,
        tokenHash: hashToken(token),
        invitedById: access.userId,
        expiresAt,
      },
      select: { id: true, email: true, roleCode: true, expiresAt: true },
    });
    const base = process.env.APP_URL ?? "http://localhost:3000";
    await this.mail.send({
      to: input.email,
      subject: `You have been invited to ${access.tenantName} on FleetOS`,
      text: `Accept your invitation: ${base}/invitations/accept?token=${token}\nThis link expires at ${expiresAt.toISOString()}.`,
    });
    return invitation;
  }

  /** Accepts an invitation for the logged-in user. The token is single-use and bound to the invited email. */
  async acceptInvitation(userId: string, userEmail: string, token: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { tenant: { select: { status: true } } },
    });
    if (!invitation) throw new NotFoundException("invitation_not_found");
    if (invitation.email !== userEmail) throw new ForbiddenException("invitation_email_mismatch");
    if (invitation.acceptedAt) throw new ConflictException("invitation_already_accepted");
    if (invitation.revokedAt || invitation.expiresAt <= new Date()) {
      throw new HttpException("invitation_expired", HttpStatus.GONE);
    }
    if (invitation.tenant.status !== "active") throw new ForbiddenException("tenant_not_active");

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      // Claim the invitation atomically so two concurrent accepts cannot both succeed.
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now },
      });
      if (claimed.count !== 1) throw new ConflictException("invitation_already_accepted");

      const role = await tx.role.findUniqueOrThrow({
        where: {
          tenantId_roleCode: { tenantId: invitation.tenantId, roleCode: invitation.roleCode },
        },
      });
      const existing = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: invitation.tenantId, userId } },
      });
      if (existing?.status === "active") throw new ConflictException("already_member");
      if (existing?.status === "suspended") throw new ForbiddenException("membership_suspended");

      const membership = existing
        ? await tx.tenantMembership.update({
            where: { id: existing.id },
            data: { status: "active", joinedAt: now },
          })
        : await tx.tenantMembership.create({
            data: {
              tenantId: invitation.tenantId,
              userId,
              status: "active",
              joinedAt: now,
              createdBy: invitation.invitedById,
            },
          });

      await tx.grant.createMany({
        data: [
          {
            tenantId: invitation.tenantId,
            membershipId: membership.id,
            roleId: role.id,
            grantedBy: invitation.invitedById,
          },
        ],
        skipDuplicates: true,
      });
      return {
        tenantId: invitation.tenantId,
        roleCode: invitation.roleCode,
        membershipStatus: "active" as const,
      };
    });
  }

  /** The caller's roles and permissions in this tenant, plus the driver record linked to them (if any). */
  async accessProfile(access: TenantAccess) {
    const driver = await this.prisma.driver.findFirst({
      where: { tenantId: access.tenantId, linkedUserId: access.userId },
      select: { id: true },
    });
    return {
      tenantId: access.tenantId,
      roleCodes: access.roleCodes,
      permissions: [...access.permissions].sort(),
      linkedDriverId: driver?.id ?? null,
    };
  }
}
