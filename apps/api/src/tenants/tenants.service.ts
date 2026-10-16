import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { createTenantRoles, ensurePermissionCatalog } from "../database/catalog.js";
import { generateToken, hashToken } from "../common/security.js";
import { MAIL_TRANSPORT, type MailTransport } from "../common/mail.js";
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

  /** Caller must be an active member of the tenant holding the company_admin role. Checked server-side. */
  async assertTenantAdmin(userId: string, tenantId: string): Promise<{ name: string }> {
    const membership = await this.prisma.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      include: {
        grants: { include: { role: { select: { roleCode: true } } } },
        tenant: { select: { name: true, status: true } },
      },
    });
    if (!membership) throw new NotFoundException("tenant_not_found");
    const isAdmin = membership.grants.some((g) => g.role.roleCode === "company_admin");
    if (membership.status !== "active" || !isAdmin || membership.tenant.status !== "active") {
      throw new ForbiddenException("company_admin_required");
    }
    return { name: membership.tenant.name };
  }

  async createInvitation(
    actorId: string,
    tenantId: string,
    input: { email: string; roleCode: RoleCode },
  ) {
    const { name } = await this.assertTenantAdmin(actorId, tenantId);
    const token = generateToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const invitation = await this.prisma.invitation.create({
      data: {
        tenantId,
        email: input.email,
        roleCode: input.roleCode,
        tokenHash: hashToken(token),
        invitedById: actorId,
        expiresAt,
      },
      select: { id: true, email: true, roleCode: true, expiresAt: true },
    });
    const base = process.env.APP_URL ?? "http://localhost:3000";
    await this.mail.send({
      to: input.email,
      subject: `You have been invited to ${name} on FleetOS`,
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
}
