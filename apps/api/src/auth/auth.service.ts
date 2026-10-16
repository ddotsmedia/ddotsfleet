import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { generateToken, hashPassword, hashToken, verifyPassword } from "../common/security.js";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
}

interface FailureRecord {
  count: number;
  windowStart: number;
}

@Injectable()
export class AuthService {
  // Per-process limiter. Replace with a shared store (Redis) before running more than one API replica.
  private readonly failures = new Map<string, FailureRecord>();

  constructor(private readonly prisma: PrismaService) {}

  async register(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<PublicUser> {
    const passwordHash = await hashPassword(input.password);
    try {
      const user = await this.prisma.user.create({
        data: { email: input.email, displayName: input.displayName, passwordHash },
        select: { id: true, email: true, displayName: true },
      });
      return user;
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "P2002")
        throw new ConflictException("email_already_registered");
      throw e;
    }
  }

  /** Returns the user and a fresh session token. Failure responses never reveal which part was wrong. */
  async login(email: string, password: string): Promise<{ user: PublicUser; token: string }> {
    if (this.isLocked(email)) {
      throw new HttpException("too_many_attempts", HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Hash even when the user is unknown so response timing does not reveal account existence.
    let ok = false;
    if (user?.passwordHash) {
      ok = await verifyPassword(password, user.passwordHash);
    } else {
      await hashPassword(password);
    }
    if (!user || !ok) {
      this.recordFailure(email);
      throw new UnauthorizedException("invalid_credentials");
    }
    this.failures.delete(email);
    const token = await this.createSession(user.id);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return { user: { id: user.id, email: user.email, displayName: user.displayName }, token };
  }

  async createSession(userId: string): Promise<string> {
    const token = generateToken();
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return token;
  }

  async resolveSession(
    token: string,
  ): Promise<{ userId: string; email: string; sessionId: string }> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { email: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new UnauthorizedException("session_invalid");
    }
    return { userId: session.userId, email: session.user.email, sessionId: session.id };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string): Promise<PublicUser> {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, displayName: true },
    });
  }

  private isLocked(email: string): boolean {
    const record = this.failures.get(email);
    if (!record) return false;
    if (Date.now() - record.windowStart > LOGIN_WINDOW_MS) {
      this.failures.delete(email);
      return false;
    }
    return record.count >= MAX_LOGIN_FAILURES;
  }

  private recordFailure(email: string): void {
    const now = Date.now();
    const record = this.failures.get(email);
    if (!record || now - record.windowStart > LOGIN_WINDOW_MS) {
      this.failures.set(email, { count: 1, windowStart: now });
    } else {
      record.count += 1;
    }
  }
}
