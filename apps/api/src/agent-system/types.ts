import type { AgentInput, AgentResult, ToolExecutor } from '../agents/types.js';
import type { LilibagToolName } from '../agents/tools.js';

export const lilibagAgentKeys = ['attendant', 'support', 'product'] as const;
export type LilibagAgentKey = typeof lilibagAgentKeys[number];

export type AgentProfileDefinition = {
  key: LilibagAgentKey;
  name: string;
  handoffDescription: string;
  responsibility: string;
  allowedTools: readonly LilibagToolName[];
};

export type AgentRunDefinition = {
  id: 'lilibag.message.inbound';
  entryAgent: 'attendant';
  workflowName: 'lilibag_attendance';
  maxTurns: number;
};

export type LilibagAgentRuntimeContext = {
  organizationId: string;
  conversationId: string;
  agentRunId: string;
  executeTool: ToolExecutor;
};

export type AgentRuntimeAvailability =
  | { available: true; apiKey: string; model: string; enabled: Record<LilibagAgentKey, boolean> }
  | { available: false; reason: 'openai_api_key_not_configured' | 'data_encryption_key_not_configured' | 'agent_disabled' };

export type AgentRuntimeProvider = {
  run(input: AgentInput, tools: unknown[], executeTool: ToolExecutor): Promise<AgentResult>;
};
