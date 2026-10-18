import { apiFetch, describeError, isRetryable } from "./api";
import { listItems, patchItem, putItem, removeItem, type OutboxItem } from "./outbox";

/** Fired on window whenever the outbox changes, so screens can refresh. */
export const OUTBOX_EVENT = "fleetos:outbox";

function notify(): void {
  window.dispatchEvent(new Event(OUTBOX_EVENT));
}

let running: Promise<void> | null = null;

/** Single-flight: overlapping triggers (online event, timer, button) share one drain. */
export function flushOutbox(): Promise<void> {
  if (!running) {
    running = drain().finally(() => {
      running = null;
      notify();
    });
  }
  return running;
}

async function drain(): Promise<void> {
  const pending = (await listItems()).filter((item) => item.status === "pending");
  for (const item of pending) {
    try {
      await apiFetch("POST", item.path, item.body);
      await removeItem(item.id);
    } catch (err) {
      if (isRetryable(err)) {
        // Stop here so later writes do not overtake this one; the next trigger retries it.
        await patchItem(item.id, { attempts: item.attempts + 1, lastError: describeError(err) });
        return;
      }
      await patchItem(item.id, {
        status: "failed",
        attempts: item.attempts + 1,
        lastError: describeError(err),
      });
    }
  }
}

/** Queues a write with a fresh idempotency key, then sends it straight away if possible. */
export async function enqueueWrite(input: {
  tenantId: string;
  label: string;
  path: string;
  body: Record<string, unknown>;
}): Promise<void> {
  const id = crypto.randomUUID();
  const item: OutboxItem = {
    id,
    tenantId: input.tenantId,
    label: input.label,
    path: input.path,
    body: { ...input.body, clientRef: id },
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
  };
  await putItem(item);
  notify();
  void flushOutbox();
}

export async function retryItem(id: string): Promise<void> {
  await patchItem(id, { status: "pending", attempts: 0, lastError: null });
  notify();
  await flushOutbox();
}

export async function discardItem(id: string): Promise<void> {
  await removeItem(id);
  notify();
}
