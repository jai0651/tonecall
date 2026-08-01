import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimDialTarget,
  clearDialRole,
  getDialRole,
  markDialInitiator,
  setPendingDial,
} from './dialRegistry';

describe('dialRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims the pending target and assigns the initiator role', () => {
    setPendingDial('+14800000001', '+16780000002');
    expect(claimDialTarget('+14800000001', 'call-1')).toBe('+16780000002');
    expect(getDialRole('call-1')).toBe('initiator');
    clearDialRole('call-1');
  });

  it('is idempotent for the claiming callUuid (webhook retry)', () => {
    setPendingDial('+14800000011', '+16780000012');
    expect(claimDialTarget('+14800000011', 'call-2')).toBe('+16780000012');
    expect(claimDialTarget('+14800000011', 'call-2')).toBe('+16780000012');
    clearDialRole('call-2');
  });

  it('refuses a second callUuid for the same number (twin leg never double-Dials)', () => {
    setPendingDial('+14800000021', '+16780000022');
    expect(claimDialTarget('+14800000021', 'call-3')).toBe('+16780000022');
    expect(claimDialTarget('+14800000021', 'call-3-twin')).toBeNull();
    expect(getDialRole('call-3-twin')).toBe('responder');
    clearDialRole('call-3');
  });

  it('returns null when nothing is pending (inbound human call)', () => {
    expect(claimDialTarget('+14800000031', 'call-4')).toBeNull();
    expect(getDialRole('call-4')).toBe('responder');
  });

  it('expires pending dials after the TTL', () => {
    setPendingDial('+14800000041', '+16780000042');
    vi.advanceTimersByTime(61_000);
    expect(claimDialTarget('+14800000041', 'call-5')).toBeNull();
  });

  it('normalizes bare-digit numbers to E.164 form', () => {
    setPendingDial('14800000051', '16780000052');
    expect(claimDialTarget('+14800000051', 'call-6')).toBe('+16780000052');
    clearDialRole('call-6');
  });

  it('markDialInitiator sets the role directly (simulator path)', () => {
    markDialInitiator('sim-call');
    expect(getDialRole('sim-call')).toBe('initiator');
    clearDialRole('sim-call');
    expect(getDialRole('sim-call')).toBe('responder');
  });
});
