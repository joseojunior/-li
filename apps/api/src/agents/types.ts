import type { z } from 'zod';

export type AgentMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  type: string;
  body: string | null;
  createdAt: string;
};

export type AgentInput = {
  runId: string;
  organizationId: string;
  conversationId: string;
  messageIds: string[];
  messages: AgentMessage[];
  instructions?: string;
  specialistPrompts?: Partial<Record<'support' | 'product', string>>;
  promptVersion?: string;
};

export type AgentResult = {
  status: 'waiting_configuration' | 'completed' | 'failed' | 'cancelled';
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  output: Record<string, unknown>;
  errorCode?: string;
  errorDetail?: string;
};

export type AgentToolContext = {
  agentRunId: string;
  organizationId: string;
  conversationId: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolExecutor = (name: string, input: unknown) => Promise<Record<string, unknown>>;

export interface AgentTool<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: TSchema;
  execute(context: AgentToolContext, input: z.infer<TSchema>): Promise<Record<string, unknown>>;
}

export interface AgentProvider {
  name: string;
  run(input: AgentInput, tools: ToolDefinition[], executeTool: ToolExecutor): Promise<AgentResult>;
}
