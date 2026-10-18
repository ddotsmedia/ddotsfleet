"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch, ApiError } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [tenantId, setTenantId] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("POST", "/auth/login", { email, password });
      router.push(`/driver/${tenantId.trim()}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `Sign-in failed (${err.code}).`
          : "Cannot reach FleetOS. Check the connection.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Driver sign-in</h1>
      <form onSubmit={submit}>
        <label>
          Company ID{" "}
          <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} required />
        </label>
        <label>
          Email{" "}
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password{" "}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          Sign in
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
