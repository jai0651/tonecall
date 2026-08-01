import type { AgentConfig } from '@/types';

/**
 * Two-agent config.
 *
 * Both DIDs currently live on Plivo Account 1, so both agents use
 * accountId='1'. (The AgentConfig.accountId field is kept as a '1'|'2'
 * union so a future cross-account split — moving one DID to Account 2 —
 * is a one-line change here, not a code refactor.)
 *
 *   vegetable_vendor → Account 1 · PLIVO_NUMBER_A
 *   pizza_shop       → Account 1 · PLIVO_NUMBER_B
 *
 * Numbers come from PLIVO_NUMBER_A / PLIVO_NUMBER_B. Voices and prompts
 * are baked-in personas — override with env if you want.
 */

let cached: { configs: AgentConfig[]; byNumber: Map<string, AgentConfig> } | null = null;

function build(): { configs: AgentConfig[]; byNumber: Map<string, AgentConfig> } {
  const numberA = process.env.PLIVO_NUMBER_A ?? '+1AAAAAAAAAA';
  const numberB = process.env.PLIVO_NUMBER_B ?? '+1BBBBBBBBBB';
  // Federation mode: when AGENT_OWNED is set, this middleware represents
  // only that one agent. The other agent is on a separate middleware,
  // discovered via the AVIP-0 broker using the shared coordination key
  // (deterministic conference name).
  // Unset = full single-middleware demo with both agents on the same box.
  const owned = process.env.AGENT_OWNED?.trim().toLowerCase();
  const configs: AgentConfig[] = [
    {
      number: numberA,
      name: 'vegetable_vendor',
      voice: 'onyx',
      accountId: '1',
      prompt:
        "You are Anil, owner of Mumbai Fresh Produce — a wholesale vegetable supplier serving " +
        'restaurants and cafes in the area. ' +
        "Today's stock (wholesale rates per kilo, INR):\n" +
        '  - Roma tomatoes: ₹40/kg (50 kg available)\n' +
        '  - Red onions: ₹35/kg (100 kg available)\n' +
        '  - Fresh basil: ₹120/kg (3 kg available)\n' +
        '  - Green capsicum: ₹60/kg (20 kg available)\n' +
        '  - Button mushrooms: ₹180/kg (5 kg available)\n' +
        '  - Garlic: ₹150/kg (15 kg available)\n' +
        'Delivery slots open tomorrow at 5:00, 6:00, 7:00, and 8:00 AM. ' +
        'Payment: UPI to anil@oksbi, or cash on delivery. ' +
        'Style: terse, friendly, get to the order details fast. No fluff. ' +
        'When the deal is closed (or it is clear there is no deal), respond with ' +
        'EXACTLY `{"type":"bye"}`.',
      capabilities: ['produce_wholesale_v1'],
    },
    {
      number: numberB,
      name: 'pizza_shop',
      voice: 'nova',
      // Account 1 (same as vegetable_vendor). Verified via Plivo REST:
      // GET /Number/+1BBBBBBBBBB/ returned a Number record on Account 1.
      // The hangup REST call routed against this accountId, so getting
      // it wrong meant our explicit hangup silently 404'd and we relied
      // on Plivo's natural conference teardown to drop the leg.
      accountId: '1',

      prompt:
        'You are the procurement agent for Bella Pizza, a busy pizzeria. ' +
        "You're calling vegetable suppliers to source ingredients for tomorrow's service. " +
        "Today's needs:\n" +
        '  - Tomatoes (for sauce): ~20 kg, prefer Roma\n' +
        '  - Onions: ~5 kg, red preferred\n' +
        '  - Fresh basil: ~1 kg\n' +
        '  - Green capsicum: ~10 kg\n' +
        '  - Button mushrooms: ~3 kg\n' +
        'Delivery must arrive by 7:00 AM tomorrow at the latest. ' +
        'Budget cap: ₹2500 for this batch. Payment via UPI from billing@bellapizza. ' +
        'Style: terse, businesslike, drive the conversation toward a confirmed order. ' +
        'When the deal is closed (or no deal is possible), respond with ' +
        'EXACTLY `{"type":"bye"}`.',
      capabilities: ['restaurant_procurement_v1'],
    },
  ];
  const filtered = owned ? configs.filter((c) => c.name.toLowerCase() === owned) : configs;
  if (owned && filtered.length === 0) {
    throw new Error(
      `AGENT_OWNED=${owned} matched no agent. Valid names: ${configs.map((c) => c.name).join(', ')}`,
    );
  }
  if (owned) {
    console.log(`[agentConfigs] federation mode: this middleware owns only "${owned}"`);
  }
  return { configs: filtered, byNumber: new Map(filtered.map((c) => [c.number, c])) };
}

function table(): { configs: AgentConfig[]; byNumber: Map<string, AgentConfig> } {
  if (!cached) cached = build();
  return cached;
}

export function getAgentConfig(number: string): AgentConfig | undefined {
  return table().byNumber.get(number);
}

export function listAgentConfigs(): AgentConfig[] {
  return [...table().configs];
}

/** Convenience: lookup which Plivo account owns this number. */
export function accountForNumber(number: string): '1' | '2' | undefined {
  return table().byNumber.get(number)?.accountId;
}
