/**
 * UserActiveDailyStore — deduplicates `user.active` emissions to at most one
 * per `(tenantId, userId, utcDay)` triple (issue #153).
 *
 * The in-memory implementation is suitable for single-process local mode
 * and for tests. A production Firestore-backed implementation should map
 * to a `createOnly` write at:
 *
 *   tenants/{tenantId}/userActiveDaily/{YYYY-MM-DD}/{userId}
 *
 * so the dedupe survives process restarts and is enforced across
 * horizontally-scaled instances. `markIfFirst` MUST be atomic and return
 * `true` only for the actual first writer.
 */
export interface UserActiveDailyStore {
  /**
   * Atomically record activity for `(tenantId, userId, utcDay)`. Returns
   * `true` if this is the first hit on that day (caller should emit the
   * `user.active` event), `false` if it was already recorded.
   */
  markIfFirst(tenantId: string, userId: string, utcDay: string): Promise<boolean>;
}

export class InMemoryUserActiveDailyStore implements UserActiveDailyStore {
  private readonly seen = new Set<string>();

  private key(tenantId: string, userId: string, utcDay: string): string {
    return `${tenantId}::${userId}::${utcDay}`;
  }

  async markIfFirst(
    tenantId: string,
    userId: string,
    utcDay: string
  ): Promise<boolean> {
    const k = this.key(tenantId, userId, utcDay);
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }

  /** Test helper. */
  clear(): void {
    this.seen.clear();
  }
}

export function utcDayString(input: Date | string = new Date()): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  return d.toISOString().slice(0, 10);
}
