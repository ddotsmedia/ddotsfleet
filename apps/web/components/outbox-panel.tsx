"use client";

import { discardItem, retryItem, flushOutbox } from "@/lib/sync";
import type { OutboxItem } from "@/lib/outbox";

/** Every queued write is visible: pending items wait for the network, failed items need a decision. */
export function OutboxPanel({ items }: { items: OutboxItem[] }) {
  return (
    <section aria-label="Sync status">
      <h2>Sync</h2>
      <p>
        {items.length === 0
          ? "No items waiting."
          : `${items.filter((i) => i.status === "pending").length} waiting to send, ${items.filter((i) => i.status === "failed").length} need attention.`}
      </p>
      <button type="button" onClick={() => void flushOutbox()}>
        Sync now
      </button>
      <ul>
        {items.map((item) => (
          <li key={item.id} data-testid="outbox-item" data-status={item.status}>
            <strong>{item.label}</strong>{" "}
            <span>{item.status === "pending" ? "Pending" : "Failed"}</span>
            {item.lastError && item.status === "failed" ? (
              <div>Reason: {item.lastError}</div>
            ) : null}
            {item.status === "failed" ? (
              <>
                <button type="button" onClick={() => void retryItem(item.id)}>
                  Retry
                </button>{" "}
                <button type="button" onClick={() => void discardItem(item.id)}>
                  Discard
                </button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
