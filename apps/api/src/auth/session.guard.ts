import {
  createParamDecorator,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { AuthService } from "./auth.service.js";
import type { AuthContext, CookieRequest } from "../common/validation.js";

export const SESSION_COOKIE = "fleetos_session";

export function readCookie(
  header: string | string[] | undefined,
  name: string,
): string | undefined {
  const raw = Array.isArray(header) ? header.join(";") : header;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CookieRequest>();
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException("session_required");
    const session = await this.auth.resolveSession(token);
    req.auth = { userId: session.userId, email: session.email, sessionId: session.sessionId };
    return true;
  }
}

/** The authenticated caller. Only valid on routes protected by SessionGuard. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const req = context.switchToHttp().getRequest<CookieRequest>();
    if (!req.auth) throw new UnauthorizedException("session_required");
    return req.auth;
  },
);
