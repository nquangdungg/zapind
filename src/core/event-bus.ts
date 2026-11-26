import type {
  ZapindEventHandler,
  ZapindEventMap,
  ZapindEventName,
  UnsubscribeFn,
} from '../models/events.js';
import type { Logger } from './policies.js';

export class EventBus {
  private readonly listeners = new Map<ZapindEventName, Set<ZapindEventHandler<ZapindEventName>>>();

  constructor(private readonly logger: Logger) {}

  public on<K extends ZapindEventName>(event: K, handler: ZapindEventHandler<K>): UnsubscribeFn {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as ZapindEventHandler<ZapindEventName>);
    return () => this.off(event, handler);
  }

  public once<K extends ZapindEventName>(event: K, handler: ZapindEventHandler<K>): UnsubscribeFn {
    const wrapped: ZapindEventHandler<K> = async (payload) => {
      this.off(event, wrapped);
      await handler(payload);
    };
    return this.on(event, wrapped);
  }

  public off<K extends ZapindEventName>(event: K, handler: ZapindEventHandler<K>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler as ZapindEventHandler<ZapindEventName>);
    if (set.size === 0) this.listeners.delete(event);
  }

  private invokeHandler<K extends ZapindEventName>(
    event: K,
    handler: ZapindEventHandler<ZapindEventName>,
    payload: ZapindEventMap[K],
  ): void {
    try {
      const result = handler(payload as never);
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        (result as Promise<void>).catch((err: unknown) => {
          this.logger.error('Event handler threw an error', {
            event,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err: unknown) {
      this.logger.error('Event handler threw an error', {
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public emit<K extends ZapindEventName>(event: K, payload: ZapindEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;

    if (set.size === 1) {
      const single = set.values().next().value;
      if (single) this.invokeHandler(event, single, payload);
      return;
    }

    for (const handler of [...set]) {
      this.invokeHandler(event, handler, payload);
    }
  }

  public listenerCount(event?: ZapindEventName): number {
    if (event) return this.listeners.get(event)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  public removeAllListeners(event?: ZapindEventName): void {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }
}
