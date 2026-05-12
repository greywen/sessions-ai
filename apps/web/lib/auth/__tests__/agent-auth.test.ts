import { describe, it, expect } from 'vitest';
import { isAgentContext, type AgentContext } from '../agent-auth';

describe('Agent Authentication Type Guardian', () => {
  it('should identify AgentContext', () => {
    const ctx: AgentContext = {
      machine: { id: '123', fingerprint: 'fp', status: 'active' },
    };
    expect(isAgentContext(ctx)).toBe(true);
  });

  it('should identify Response', () => {
    const res = new Response('error', { status: 401 });
    expect(isAgentContext(res as unknown as AgentContext | Response)).toBe(false);
  });
});
