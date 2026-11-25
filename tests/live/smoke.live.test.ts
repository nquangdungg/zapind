import { describe, expect, it } from 'vitest';
import { Zapind } from '../../src/index.js';

const LIVE = process.env.ZAPIND_LIVE_TEST === '1';

describe.skipIf(!LIVE)('Zapind live smoke test (ZAPIND_LIVE_TEST=1)', () => {
  it('restores session and fetches account profile', async () => {
    const sessionPath = process.env.ZAPIND_SESSION_PATH;
    if (!sessionPath) throw new Error('ZAPIND_SESSION_PATH is required when ZAPIND_LIVE_TEST=1');

    const client = new Zapind({ session: sessionPath });
    await client.login();
    const me = await client.account.getMe();
    expect(me.id.length).toBeGreaterThan(0);
    await client.logout({ clearSession: false });
  });
});
