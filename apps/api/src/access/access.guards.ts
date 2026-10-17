import {
  createParamDecorator,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { z } from "zod";
import { AccessService, type TenantAccess } from "./access.service.js";
import { parseInput, type CookieRequest } from "../common/validation.js";

export interface TenantRequest extends CookieRequest {
  params: Record<string, string | undefined>;
  tenantAccess?: TenantAccess;
}

const PERMISSIONS_KEY = "required_permissions";

/** Declares the permissions a route needs. Enforced by PermissionsGuard; requires TenantGuard first. */
export const RequirePermissions = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);

/**
 * Binds the caller to the tenant named in the path (never in the body) and loads live access.
 * Must run after SessionGuard.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly access: AccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<TenantRequest>();
    if (!req.auth) throw new UnauthorizedException("session_required");
    const tenantId = parseInput(z.uuid(), req.params.tenantId);
    req.tenantAccess = await this.access.resolve(req.auth.userId, tenantId);
    return true;
  }
}

/** Fails closed: a route with required permissions but no tenant context is refused. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.length === 0) return true;
    const access = context.switchToHttp().getRequest<TenantRequest>().tenantAccess;
    if (!access) throw new ForbiddenException("tenant_context_required");
    if (!required.every((code) => access.permissions.has(code))) {
      throw new ForbiddenException("permission_denied");
    }
    return true;
  }
}

export const TenantAccessContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantAccess => {
    const access = context.switchToHttp().getRequest<TenantRequest>().tenantAccess;
    if (!access) throw new ForbiddenException("tenant_context_required");
    return access;
  },
);
