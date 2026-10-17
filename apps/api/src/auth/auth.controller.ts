import { Body, Controller, Get, HttpCode, Post, Res, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AuthService, SESSION_TTL_MS } from "./auth.service.js";
import { CurrentAuth, SESSION_COOKIE, SessionGuard } from "./session.guard.js";
import { parseInput, type AuthContext, type CookieResponse } from "../common/validation.js";

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

const registerSchema = z.object({
  email,
  password: z.string().min(12).max(256),
  displayName: z.string().trim().min(2).max(120),
});

const loginSchema = z.object({
  email,
  password: z.string().min(1).max(256),
});

function cookieOptions(): Record<string, unknown> {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  async register(@Body() body: unknown) {
    return this.auth.register(parseInput(registerSchema, body));
  }

  @Post("login")
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: CookieResponse) {
    const { email: address, password } = parseInput(loginSchema, body);
    const { user, token } = await this.auth.login(address, password);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_TTL_MS });
    return user;
  }

  @Post("logout")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async logout(
    @CurrentAuth() caller: AuthContext,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    await this.auth.logout(caller.sessionId);
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    return { status: "ok" };
  }

  @Get("me")
  @UseGuards(SessionGuard)
  async me(@CurrentAuth() caller: AuthContext) {
    return this.auth.me(caller.userId);
  }
}
