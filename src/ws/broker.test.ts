import { describe, expect, it, vi } from 'vitest';
import { requestPairing } from './broker';

describe('broker requestPairing', () => {
  it('cross-matching nonces resolve both sides with the same sessionId', async () => {
    const a = requestPairing({
      callUuid: 'call-a',
      myNonce: '10000001',
      peerNonce: '20000002',
      agentNumber: '+14800000001',
    });
    const b = requestPairing({
      callUuid: 'call-b',
      myNonce: '20000002',
      peerNonce: '10000001',
      agentNumber: '+16780000002',
    });
    const [sessionA, sessionB] = await Promise.all([a, b]);
    expect(sessionA).toBe(sessionB);
    expect(sessionA).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects when the peer never arrives', async () => {
    vi.useFakeTimers();
    try {
      const lonely = requestPairing({
        callUuid: 'call-lonely',
        myNonce: '30000003',
        peerNonce: '40000004',
        agentNumber: '+14800000003',
      });
      const assertion = expect(lonely).rejects.toThrow(/pair timeout/);
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not pair when the claimed peer nonce does not match', async () => {
    vi.useFakeTimers();
    try {
      // A claims peer 60000006, but the arriving "peer" claims a different
      // counterpart — the broker must NOT match them.
      const a = requestPairing({
        callUuid: 'call-a2',
        myNonce: '50000005',
        peerNonce: '60000006',
        agentNumber: '+14800000004',
      });
      const impostor = requestPairing({
        callUuid: 'call-x',
        myNonce: '60000006',
        peerNonce: '70000007', // wrong — real A said its nonce was 50000005
        agentNumber: '+19990000000',
      });
      const aAssertion = expect(a).rejects.toThrow(/pair timeout/);
      const impostorAssertion = expect(impostor).rejects.toThrow(/pair timeout/);
      await vi.advanceTimersByTimeAsync(10_001);
      await aAssertion;
      await impostorAssertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
