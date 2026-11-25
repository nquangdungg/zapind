import { ThreadType } from '../models/enums.js';

export interface ThreadTargetLike {
  readonly id: string;
  readonly threadType?: ThreadType;
}

/**
 * Automatically resolves ThreadType (User vs Group) without blind guessing:
 * 1. Explicit override if provided
 * 2. Contextual model's own threadType (User / Group / Conversation / Message)
 * 3. Cached set of known Group IDs populated lazily from getAllGroups() & runtime events
 */
export class ThreadTypeRegistry {
  private readonly groupIds = new Set<string>();
  private readonly userIds = new Set<string>();
  private groupsLoadedAt = 0;
  private readonly groupsTtlMs: number;
  private loadingGroups: Promise<void> | null = null;

  constructor(groupsTtlMs = 5 * 60_000) {
    this.groupsTtlMs = groupsTtlMs;
  }

  public registerGroup(groupId: string): void {
    if (!groupId) return;
    this.groupIds.add(groupId);
    this.userIds.delete(groupId);
  }

  public registerGroups(ids: Iterable<string>): void {
    for (const id of ids) {
      if (id) {
        this.groupIds.add(id);
        this.userIds.delete(id);
      }
    }
    this.groupsLoadedAt = Date.now();
  }

  public registerUser(userId: string): void {
    if (!userId) return;
    if (!this.groupIds.has(userId)) {
      this.userIds.add(userId);
    }
  }

  public extractId(target: string | ThreadTargetLike): string {
    return typeof target === 'string' ? target.trim() : target.id.trim();
  }

  public async resolve(
    target: string | ThreadTargetLike,
    explicitType: ThreadType | undefined,
    fetchAllGroupIds?: () => Promise<string[]>,
  ): Promise<{ threadId: string; threadType: ThreadType }> {
    const threadId = this.extractId(target);

    if (explicitType !== undefined) {
      if (explicitType === ThreadType.Group) this.registerGroup(threadId);
      else this.registerUser(threadId);
      return { threadId, threadType: explicitType };
    }

    if (typeof target !== 'string' && target.threadType !== undefined) {
      return { threadId, threadType: target.threadType };
    }

    if (this.groupIds.has(threadId)) {
      return { threadId, threadType: ThreadType.Group };
    }
    if (this.userIds.has(threadId)) {
      return { threadId, threadType: ThreadType.User };
    }

    const isStale = Date.now() - this.groupsLoadedAt > this.groupsTtlMs;
    if (fetchAllGroupIds && isStale) {
      if (!this.loadingGroups) {
        this.loadingGroups = fetchAllGroupIds()
          .then((ids) => {
            this.registerGroups(ids);
          })
          .catch(() => {
            // Best-effort refresh; keep existing cache
          })
          .finally(() => {
            this.loadingGroups = null;
          });
      }
      await this.loadingGroups;
      if (this.groupIds.has(threadId)) {
        return { threadId, threadType: ThreadType.Group };
      }
    }

    return { threadId, threadType: ThreadType.User };
  }

  public clear(): void {
    this.groupIds.clear();
    this.userIds.clear();
    this.groupsLoadedAt = 0;
    this.loadingGroups = null;
  }
}
