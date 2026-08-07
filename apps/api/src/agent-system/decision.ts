import { z } from 'zod';

// This is the boundary between a probabilistic model answer and deterministic
// application work. The model can choose an action and known product IDs, but
// never gets to provide an arbitrary media URL or dispatch a channel request.
const replyDecisionSchema = z.object({
  action: z.literal('reply'),
  message: z.string().trim().min(1).max(4_000),
  mediaProductIds: z.array(z.string().uuid()).max(2).default([]),
  handoffReason: z.null().default(null)
});

const handoffDecisionSchema = z.object({
  action: z.literal('handoff'),
  message: z.string().trim().min(1).max(1_000),
  mediaProductIds: z.array(z.string().uuid()).max(2).default([]),
  handoffReason: z.string().trim().min(3).max(500)
});

// The current TypeScript SDK accepts a Zod object (rather than a discriminated
// union) as an outputType. Parse the stricter union below at the application
// boundary before doing any side effect.
export const agentDecisionOutputSchema = z.object({
  action: z.enum(['reply', 'handoff']),
  message: z.string().trim().min(1).max(4_000),
  mediaProductIds: z.array(z.string().uuid()).max(2).default([]),
  handoffReason: z.string().trim().min(3).max(500).nullable().default(null)
});

export const agentDecisionSchema = z.discriminatedUnion('action', [
  replyDecisionSchema,
  handoffDecisionSchema
]);

export type AgentDecision = z.infer<typeof agentDecisionSchema>;

export function parseAgentDecision(value: unknown): AgentDecision {
  return agentDecisionSchema.parse(value);
}
