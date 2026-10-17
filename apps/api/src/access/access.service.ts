import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import type { RoleCode } from "../generated/prisma/client.js";

export interface TenantAccess {
  userId: string;
  tenantId: string;
  tenantName: string;
  membershipId: string;
  roleCodes: RoleCode[];
  permissions: ReadonlySet<string>;
}

@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the caller's access to one tenant from the database on every request, so revoked grants
   * and suspended memberships apply to the next request. Non-members get 404 to avoid revealing tenants.
   */
  async resolve(userId: string, tenantId: string): Promise<TenantAccess> {
    const membership = await this.prisma.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      include: {
        tenant: { select: { name: true, status: true } },
        grants: {
          select: {
            role: {
              select: {
                roleCode: true,
                permissions: { select: { permission: { select: { code: true } } } },
              },
            },
          },
        },
      },
    });
    if (!membership) throw new NotFoundException("tenant_not_found");
    if (membership.tenant.status !== "active") throw new ForbiddenException("tenant_not_active");
    if (membership.status !== "active") throw new ForbiddenException("membership_inactive");

    return {
      userId,
      tenantId,
      tenantName: membership.tenant.name,
      membershipId: membership.id,
      roleCodes: [...new Set(membership.grants.map((g) => g.role.roleCode))],
      permissions: new Set(
        membership.grants.flatMap((g) => g.role.permissions.map((rp) => rp.permission.code)),
      ),
    };
  }
}
