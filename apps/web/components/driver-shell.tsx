"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { useOutbox } from "@/lib/use-outbox";

export interface DriverContextValue {
  tenantId: string;
  linkedDriverId: string | null;
  permissions: string[];
}

interface AccessProfile extends DriverContextValue {
  roleCodes: string[];
}

const DriverContext = createContext<DriverContextValue | null>(null);

export function useDriver(): DriverContextValue {
  const value = useContext(DriverContext);
  if (!value) throw new Error("useDriver must be used inside DriverShell");
  return value;
}

const cacheKey = (tenantId: string) => `fleetos.profile.${tenantId}`;

function readCache(tenantId: string): AccessProfile | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(tenantId));
    return raw ? (JSON.parse(raw) as AccessProfile) : null;
  } catch {
    return null; // Storage can be blocked; the profile is then simply not cached.
  }
}

function writeCache(profile: AccessProfile): void {
  try {
    window.localStorage.setItem(cacheKey(profile.tenantId), JSON.stringify(profile));
  } catch {
    // Ignored: caching is a convenience for offline reloads only.
  }
}

export function DriverShell({ tenantId, children }: { tenantId: string; children: ReactNode }) {
  const router = useRouter();
  const [profile, setProfile] = useState<DriverContextValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const outbox = useOutbox(tenantId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fresh = await apiFetch<AccessProfile>("GET", `/tenants/${tenantId}/access`);
        writeCache(fresh);
        if (!cancelled) setProfile(fresh);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
          return;
        }
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          setError("You do not have access to this company.");
          return;
        }
        // Network failure: use the last profile seen on this device, if any.
        const cached = readCache(tenantId);
        if (cached) setProfile(cached);
        else setError("Cannot reach FleetOS and no saved session is available on this device.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, router]);

  const pending = outbox.items.filter((i) => i.status === "pending").length;
  const failed = outbox.items.filter((i) => i.status === "failed").length;

  return (
    <div>
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <strong>FleetOS driver</strong>
        <span role="status">
          {outbox.online ? "Online" : "Offline"} · {pending} waiting · {failed} failed
        </span>
      </header>
      <nav aria-label="Driver">
        <Link href={`/driver/${tenantId}`}>My day</Link> ·{" "}
        <Link href={`/driver/${tenantId}/trips`}>Trips</Link> ·{" "}
        <Link href={`/driver/${tenantId}/tasks`}>Tasks</Link> ·{" "}
        <Link href={`/driver/${tenantId}/check`}>Vehicle check</Link>
      </nav>
      <main>
        {error ? <p role="alert">{error}</p> : null}
        {profile ? (
          <DriverContext.Provider value={profile}>{children}</DriverContext.Provider>
        ) : error ? null : (
          <p>Loading…</p>
        )}
      </main>
    </div>
  );
}
