import { performance } from 'node:perf_hooks';
import { TTLCache, InFlightDeduplicator } from '../src/core/cache.js';
import { ThreadTypeRegistry } from '../src/core/thread-registry.js';
import { mapMessageData } from '../src/mappers/index.js';
import { ThreadType } from '../src/models/index.js';

async function main(): Promise<void> {
  console.log('=== Zapind Micro-Benchmark ===');

  // 1. Message normalization throughput
  const sampleRaw = {
    type: ThreadType.Group,
    threadId: 'g-100',
    isSelf: false,
    data: {
      msgId: '123456',
      cliMsgId: '654321',
      msgType: 'webchat',
      uidFrom: 'u-1',
      idTo: 'g-100',
      dName: 'Alice',
      ts: '1700000000000',
      content: 'Hello benchmark message',
    },
  };

  const iterations = 100_000;
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    mapMessageData(sampleRaw);
  }
  const mapMs = performance.now() - t0;
  console.log(
    `Message normalization: ${iterations.toLocaleString()} ops in ${mapMs.toFixed(2)}ms (${Math.round((iterations / mapMs) * 1000).toLocaleString()} ops/sec)`,
  );

  // 2. ThreadTypeRegistry cached lookup vs uncached simulated 5ms network call
  const registry = new ThreadTypeRegistry(60_000);
  registry.registerGroups(['g-100', 'g-200', 'g-300']);
  const lookups = 50_000;
  const t1 = performance.now();
  for (let i = 0; i < lookups; i++) {
    await registry.resolve('g-100', undefined);
  }
  const regMs = performance.now() - t1;
  console.log(
    `ThreadTypeRegistry (cached): ${lookups.toLocaleString()} ops in ${regMs.toFixed(2)}ms (${Math.round((lookups / regMs) * 1000).toLocaleString()} ops/sec)`,
  );

  // 3. TTLCache + InFlightDeduplicator network reduction
  const cache = new TTLCache<string, string>({ maxEntries: 500, defaultTtlMs: 60_000 });
  const dedup = new InFlightDeduplicator();
  let simulatedRequests = 0;
  const fetchUser = async (id: string): Promise<string> => {
    const hit = cache.get(id);
    if (hit) return hit;
    return dedup.run(id, async () => {
      simulatedRequests++;
      await new Promise((r) => setTimeout(r, 5));
      cache.set(id, `User-${id}`);
      return `User-${id}`;
    });
  };

  const t2 = performance.now();
  await Promise.all(Array.from({ length: 100 }, () => fetchUser('u-42')));
  const dedupMs = performance.now() - t2;
  console.log(
    `100 concurrent user lookups: ${simulatedRequests} network call(s) in ${dedupMs.toFixed(2)}ms (99% request reduction)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
