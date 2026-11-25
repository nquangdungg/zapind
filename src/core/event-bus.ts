import type {
  ZapidEventHandler,
  ZapidEventMap,
  ZapidEventName,
  UnsubscribeFn,
} from '../models/events.js';
import type { Logger } from './policies.js';

export class EventBus {
  private readonly listeners = new Map<ZapidEventName, Set<ZapidEventHandler<ZapidEventName>>>();

  constructor(private readonly logger: Logger) {}

  public on<K extends ZapidEventName>(event: K, handler: ZapidEventHandler<K>): UnsubscribeFn {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as ZapidEventHandler<ZapidEventName>);
    return () => this.off(event, handler);
  }

  public once<K extends ZapidEventName>(event: K, handler: ZapidEventHandler<K>): UnsubscribeFn {
    const wrapped: ZapidEventHandler<K> = async (payload) => {
      this.off(event, wrapped);
      await handler(payload);
    };
    return this.on(event, wrapped);
  }

  public off<K extends ZapidEventName>(event: K, handler: ZapidEventHandler<K>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler as ZapidEventHandler<ZapidEventName>);
    if (set.size === 0) this.listeners.delete(event);
  }

  public emit<K extends ZapidEventName>(event: K, payload: ZapidEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;

    for (const handler of [...set]) {
      Promise.resolve()
        .then(() => handler(payload))
        .catch((err: unknown) => {
          this.logger.error('Event handler threw an error', {
            event,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  public listenerCount(event?: ZapidEventName): number {
    if (event) return this.listeners.get(event)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  public removeAllListeners(event?: ZapidEventName): void {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }
}
