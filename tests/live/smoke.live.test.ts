import { describe, expect, it } from 'vitest';
import { Zapid } from '../../src/index.js';

const LIVE = process.env.ZAPID_LIVE_TEST === '1';

describe.skipIf(!LIVE)('Zapid live smoke test (ZAPID_LIVE_TEST=1)', () => {
  it('restores session and fetches account profile', async () => {
    const sessionPath = process.env.ZAPID_SESSION_PATH;
    if (!sessionPath) throw new Error('ZAPID_SESSION_PATH is required when ZAPID_LIVE_TEST=1');

    const client = new Zapid({ session: sessionPath });
    await client.login();
    const me = await client.account.getMe();
    expect(me.id.length).toBeGreaterThan(0);
    await client.logout({ clearSession: false });
  });
});
