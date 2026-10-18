import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../database/prisma.service.js";
import type { TenantAccess } from "./access.service.js";

/**
 * Holders of driver:write act for any driver in the tenant. Everyone else (the driver role)
 * may only act for the driver record linked to their own user account.
 */
export async function assertActsForDriver(
  prisma: PrismaService,
  access: TenantAccess,
  driverId: string | null,
): Promise<void> {
  if (access.permissions.has("driver:write")) return;
  if (!driverId) throw new ForbiddenException("driver_scope");
  const own = await prisma.driver.findFirst({
    where: { tenantId: access.tenantId, linkedUserId: access.userId },
    select: { id: true },
  });
  if (!own || own.id !== driverId) throw new ForbiddenException("driver_scope");
}

export async function loadActiveDriver(prisma: PrismaService, tenantId: string, driverId: string) {
  const driver = await prisma.driver.findFirst({
    where: { id: driverId, tenantId },
    select: { id: true, status: true },
  });
  if (!driver) throw new NotFoundException("driver_not_found");
  if (driver.status !== "active") throw new ConflictException("driver_not_active");
  return driver;
}
