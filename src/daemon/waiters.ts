import type { ServerResponse } from "node:http";

interface Waiter {
  res: ServerResponse;
  timer: NodeJS.Timeout;
}

export class Waiters {
  private byId = new Map<string, Set<Waiter>>();
  private lastSeen = new Map<string, number>();

  /** True if a supervisor long-polled this id within `withinMs` — i.e. the session is supervised. */
  recentlySeen(claudeId: string, withinMs: number, now = Date.now()): boolean {
    const t = this.lastSeen.get(claudeId);
    return t !== undefined && now - t <= withinMs;
  }

  add(claudeId: string, res: ServerResponse, timeoutMs: number): void {
    this.lastSeen.set(claudeId, Date.now());
    const set = this.byId.get(claudeId) ?? new Set<Waiter>();
    const waiter: Waiter = {
      res,
      timer: setTimeout(() => {
        this.resolve(waiter, 204, null);
        set.delete(waiter);
        if (set.size === 0) this.byId.delete(claudeId);
      }, timeoutMs),
    };
    set.add(waiter);
    this.byId.set(claudeId, set);

    res.on("close", () => {
      clearTimeout(waiter.timer);
      set.delete(waiter);
      if (set.size === 0) this.byId.delete(claudeId);
    });
  }

  notify(claudeId: string, payload: unknown): number {
    const set = this.byId.get(claudeId);
    if (!set || set.size === 0) return 0;
    const count = set.size;
    for (const waiter of [...set]) {
      this.resolve(waiter, 200, payload);
      set.delete(waiter);
    }
    if (set.size === 0) this.byId.delete(claudeId);
    return count;
  }

  count(claudeId: string): number {
    return this.byId.get(claudeId)?.size ?? 0;
  }

  closeAll(): void {
    for (const set of this.byId.values()) {
      for (const waiter of set) {
        clearTimeout(waiter.timer);
        try {
          waiter.res.end();
        } catch {
          // socket already closed
        }
      }
    }
    this.byId.clear();
  }

  private resolve(waiter: Waiter, status: number, payload: unknown): void {
    clearTimeout(waiter.timer);
    if (waiter.res.writableEnded || waiter.res.destroyed) return;
    waiter.res.statusCode = status;
    if (payload !== null) {
      const text = JSON.stringify(payload);
      waiter.res.setHeader("content-type", "application/json");
      waiter.res.setHeader("content-length", Buffer.byteLength(text));
      waiter.res.end(text);
    } else {
      waiter.res.end();
    }
  }
}
