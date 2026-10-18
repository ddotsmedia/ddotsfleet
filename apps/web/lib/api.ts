export const API_BASE = "/fleetos-api";

/** An HTTP failure from the API. `code` is the API's stable reason, e.g. "shift_not_open". */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function errorCode(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: unknown };
    if (typeof data.message === "string") return data.message;
  } catch {
    // The body is not JSON; fall back to the status code below.
  }
  return `http_${res.status}`;
}

export async function apiFetch<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    cache: "no-store",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await errorCode(res));
  return (await res.json()) as T;
}

/**
 * Network failures and 5xx/408/429/401 responses keep a queued write pending, to be replayed.
 * Other 4xx responses are business-rule rejections: the item is marked failed for the driver to see.
 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.status >= 500 || [401, 408, 429].includes(err.status);
}

export function describeError(err: unknown): string {
  return err instanceof ApiError ? err.code : "network_error";
}
