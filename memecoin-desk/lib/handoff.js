// Hard handoffs: every item carries the stage the previous agent left it in.
// An agent refuses anything that did not come from the agent directly before it,
// so nothing can skip the Filter, the Analyst, or the Risk stop.

export const STAGE = {
  SCOUTED: 'scout:found',
  FILTERED: 'filter:passed',
  ANALYZED: 'analyst:passed',
  TICKET: 'executor:ticket',
  ARMED: 'risk:armed',
};

export class HandoffError extends Error {
  constructor(agent, expected, got) {
    super(`${agent} refused handoff: expected stage "${expected}", got "${got}"`);
    this.name = 'HandoffError';
  }
}

export function expectStage(agent, item, expected) {
  if (!item || item.stage !== expected) throw new HandoffError(agent, expected, item?.stage);
}

export function handoff(item, agent, stage, note) {
  return { ...item, stage, trail: [...(item.trail || []), { agent, stage, at: Date.now(), ...(note ? { note } : {}) }] };
}
