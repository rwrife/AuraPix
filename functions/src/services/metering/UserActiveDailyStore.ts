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

/**
 * Optional capability — implementations that can enumerate distinct user
 * IDs across a UTC date range expose this so the month-to-date summary
 * endpoint (issue #188) can de-duplicate `activeUsers` rather than
 * naively summing per-day counts.
 *
 * Returns the SET of distinct userIds that were active for `tenantId` on
 * any UTC day in `[from, to]` inclusive. Both `from` and `to` are
 * `YYYY-MM-DD` UTC dates.
 */
export interface DistinctActiveUsersQuery {
  listDistinctUsers(
    tenantId: string,
    from: string,
    to: string
  ): Promise<string[]>;
}

export class InMemoryUserActiveDailyStore
  implements UserActiveDailyStore, DistinctActiveUsersQuery
{
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

  async listDistinctUsers(
    tenantId: string,
    from: string,
    to: string
  ): Promise<string[]> {
    const prefix = `${tenantId}::`;
    const distinct = new Set<string>();
    for (const k of this.seen) {
      if (!k.startsWith(prefix)) continue;
      // key = tenantId::userId::utcDay — split from the right so userIds
      // containing `::` are preserved.
      const lastSep = k.lastIndexOf('::');
      if (lastSep < 0) continue;
      const utcDay = k.slice(lastSep + 2);
      if (utcDay < from || utcDay > to) continue;
      const userId = k.slice(prefix.length, lastSep);
      distinct.add(userId);
    }
    return Array.from(distinct);
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
