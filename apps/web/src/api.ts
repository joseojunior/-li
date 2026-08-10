const developmentApiUrl = typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? `${window.location.protocol}//${window.location.hostname}:3000`
  : 'http://localhost:3000';

// In production the panel and API are served by the same HTTPS origin through
// Caddy. Keeping this relative avoids a browser call to localhost on the VPS.
const baseUrl = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.PROD ? '' : developmentApiUrl);

export type PanelUser = { id: string; organizationId: string; email: string; displayName: string; role: string };
export type Conversation = { id: string; status: 'open' | 'waiting_human' | 'closed'; last_message_at: string; contact_name: string | null; phone_e164: string | null; channel_name: string };
export type Message = { id: string; direction: 'inbound' | 'outbound'; type: string; body: string | null; delivery_status: string; created_at: string };
export type ConversationTag = { id: string; scope?: 'product' | 'conversation' | 'contact'; slug: string; name: string; color: string | null; source?: 'manual' | 'rule' | 'agent' | 'integration'; created_at: string };
export type SalesContext = { conversation_id: string; stage: string; intent: string; facts: Record<string, string | number | boolean | string[]>; last_agent_question: string | null; updated_at?: string };
export type AgentPlaybook = { id: string; name: string; version: number; checksum: string; instructions: string };
export type RoutingAction = { type: 'continue' | 'handoff' | 'pause_automation'; reason?: string; addConversationTags: string[] };
export type RoutingConditions = { channelIds?: string[]; messageTypes?: ('text' | 'image' | 'audio' | 'video' | 'document')[]; hasTagsAll?: string[]; hasTagsAny?: string[] };
export type RoutingPolicy = { id: string; name: string; priority: number; enabled: boolean; conditions: RoutingConditions; action: RoutingAction; created_at: string; updated_at: string };
export type RoutingPolicyInput = { name: string; priority: number; enabled: boolean; conditions: RoutingConditions; action: RoutingAction };
export type AgentKey = 'attendant' | 'support' | 'product';
export type AgentModel = 'gpt-5.6-luna' | 'gpt-5.6-terra' | 'gpt-5.6-sol';
export type AiAgentConfiguration = { key: AgentKey; model: AgentModel; enabled: boolean; label: string; responsibility: string; updatedAt: string | null };
export type AiConfiguration = { provider: { name: 'openai'; configured: boolean; source: 'organization' | 'environment' | 'none'; configuredAt: string | null }; agents: AiAgentConfiguration[] };
export type PromptTestResult = { status: 'waiting_configuration' | 'completed' | 'failed'; agentKey: AgentKey; model: AgentModel; promptVersion?: string; reason?: string; output?: string };
export type AgentPromptVersion = { id: string; agentKey: AgentKey; version: number; instructions: string; checksum: string; status: 'draft' | 'active' | 'archived'; createdAt: string };
export type BlingConnectionStatus = { status: 'not_configured' | 'pending' | 'active' | 'disabled' | 'error'; redirectUri?: string; clientIdHint?: string; accessTokenExpiresAt?: string | null; createdAt?: string; updatedAt?: string };
export type BlingCatalogSyncRun = { id: string; integration_job_id: string | null; mode: 'full' | 'incremental'; status: 'queued' | 'running' | 'waiting_configuration' | 'completed' | 'failed' | 'cancelled'; products_seen: number; products_upserted: number; products_deactivated: number; error_code: string | null; error_detail: string | null; started_at: string | null; completed_at: string | null; created_at: string; updated_at: string };
export type MessageChannel = { id: string; provider: 'chatai'; external_id: string; display_name: string; status: 'active' | 'paused' | 'disabled'; created_at: string; connection_status: 'pending' | 'active' | 'disabled' | null; backend_url: string | null; connection_updated_at: string | null; webhook_configured: boolean; inbound_debounce_ms: number; outbound_queue_id: number };
export type ChatAiConnectionResult = { channelId: string; status: 'pending' | 'active'; backendUrl?: string; webhookUrl: string | null; webhookUrlAvailable: boolean };
export type ChatAiTagSyncResult = { found: number; imported: number; existing: number; tags: { name: string; slug: string; color?: string }[] };
export type Product = { id: string; sku: string; name: string; description: string | null; category: string | null; tags: string[]; price_cents: number | null; currency: string; available: boolean; media: { id: string; assetId?: string | null; url: string | null; altText: string | null; position: number }[] };
export type ProductInput = { sku: string; name: string; description?: string; category?: string; tags: string[]; priceCents?: number; currency: string; available: boolean };
export type OperationTrace = { id: string; event_type: string; status: 'received' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped'; detail: Record<string, unknown>; created_at: string; conversation_id: string | null; channel_id: string | null; agent_run_id: string | null; channel_name: string | null; contact_name: string | null; phone_e164: string | null };
export type OperationTraceSummary = { total: number; failed: number; webhook: number; queue: number; agent: number };

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? 'Não foi possível concluir a operação.');
  return data as T;
}

export const api = {
  me: () => request<PanelUser>('/v1/panel/me'),
  login: (organizationSlug: string, email: string, password: string) => request<PanelUser>('/v1/auth/login', { method: 'POST', body: JSON.stringify({ organizationSlug, email, password }) }),
  logout: () => request<void>('/v1/auth/logout', { method: 'POST' }),
  conversations: () => request<{ data: Conversation[] }>('/v1/panel/conversations'),
  operationTraces: (limit = 80) => request<{ data: OperationTrace[] }>(`/v1/panel/traces?limit=${limit}`),
  operationTraceSummary: () => request<OperationTraceSummary>('/v1/panel/traces/summary'),
  messages: (conversationId: string) => request<{ data: Message[] }>(`/v1/panel/conversations/${conversationId}/messages`),
  conversationTags: (conversationId: string) => request<{ data: ConversationTag[] }>(`/v1/panel/conversations/${conversationId}/tags`),
  assignConversationTag: (conversationId: string, tagSlug: string) => request(`/v1/panel/conversations/${conversationId}/tags`, { method: 'POST', body: JSON.stringify({ tagSlug, source: 'manual' }) }),
  removeConversationTag: (conversationId: string, tagSlug: string) => request<void>(`/v1/panel/conversations/${conversationId}/tags/${encodeURIComponent(tagSlug)}`, { method: 'DELETE' }),
  salesContext: (conversationId: string) => request<SalesContext>(`/v1/panel/conversations/${conversationId}/sales-context`),
  handoff: (conversationId: string, reason: string) => request(`/v1/panel/conversations/${conversationId}/handoff`, { method: 'POST', body: JSON.stringify({ reason }) }),
  resume: (conversationId: string) => request(`/v1/panel/conversations/${conversationId}/resume`, { method: 'POST' }),
  sendMessage: (conversationId: string, body: string) => request(`/v1/panel/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ body, idempotencyKey: crypto.randomUUID() }) }),
  products: (query = '') => request<{ data: Product[] }>(`/v1/panel/products${query ? `?q=${encodeURIComponent(query)}` : ''}`),
  createProduct: (input: ProductInput) => request<Product>('/v1/panel/products', { method: 'POST', body: JSON.stringify(input) }),
  updateProduct: (productId: string, input: Partial<ProductInput>) => request<Product>(`/v1/panel/products/${productId}`, { method: 'PATCH', body: JSON.stringify(input) }),
  addProductMedia: (productId: string, input: { storageKey: string; publicUrl: string; mimeType: string; altText?: string; position?: number }) => request(`/v1/panel/products/${productId}/media`, { method: 'POST', body: JSON.stringify(input) }),
  deleteProductMedia: (productId: string, mediaId: string) => request<void>(`/v1/panel/products/${productId}/media/${mediaId}`, { method: 'DELETE' }),
  createProductMediaUpload: (productId: string, input: { filename: string; mimeType: string; byteSize: number; altText?: string; position?: number }) => request<{ assetId: string; uploadUrl: string; headers: Record<string, string> }>(`/v1/panel/products/${productId}/media/upload-intents`, { method: 'POST', body: JSON.stringify(input) }),
  completeProductMediaUpload: (productId: string, assetId: string) => request(`/v1/panel/products/${productId}/media/uploads/${assetId}/complete`, { method: 'POST' }),
  playbook: () => request<AgentPlaybook>('/v1/panel/agent/playbook'),
  tags: (scope?: 'product' | 'conversation' | 'contact') => request<{ data: ConversationTag[] }>(`/v1/panel/tags${scope ? `?scope=${scope}` : ''}`),
  createTag: (input: { scope: 'product' | 'conversation' | 'contact'; slug: string; name: string; color?: string }) => request<ConversationTag>('/v1/panel/tags', { method: 'POST', body: JSON.stringify(input) }),
  routingPolicies: () => request<{ data: RoutingPolicy[] }>('/v1/panel/routing-policies'),
  createRoutingPolicy: (input: RoutingPolicyInput) => request<RoutingPolicy>('/v1/panel/routing-policies', { method: 'POST', body: JSON.stringify(input) }),
  blingConnection: () => request<BlingConnectionStatus>('/v1/panel/integrations/bling'),
  saveBlingConnection: (clientId: string, clientSecret: string) => request<BlingConnectionStatus>('/v1/panel/integrations/bling/connection', { method: 'PUT', body: JSON.stringify({ clientId, clientSecret }) }),
  beginBlingAuthorization: () => request<{ authorizationUrl: string; expiresAt: string }>('/v1/panel/integrations/bling/authorization', { method: 'POST' }),
  blingCatalogSyncRuns: () => request<{ data: BlingCatalogSyncRun[] }>('/v1/panel/integrations/bling/catalog-sync-runs'),
  requestBlingCatalogSync: (mode: 'full' | 'incremental') => request<{ accepted: boolean; duplicate: boolean; integrationJobId: string | null }>('/v1/panel/integrations/bling/catalog-sync', { method: 'POST', body: JSON.stringify({ mode }) }),
  channels: () => request<{ data: MessageChannel[] }>('/v1/panel/channels'),
  createChatAiChannel: (input: { displayName: string; externalId?: string }) => request<MessageChannel>('/v1/panel/channels', { method: 'POST', body: JSON.stringify(input) }),
  generateChatAiWebhook: (channelId: string, input: { processingDelayMs: number }) => request<ChatAiConnectionResult>(`/v1/panel/channels/${channelId}/webhook`, { method: 'POST', body: JSON.stringify(input) }),
  chatAiWebhook: (channelId: string) => request<ChatAiConnectionResult>(`/v1/panel/channels/${channelId}/webhook`),
  simulateChatAiInbound: (channelId: string, input: { message: string; contactName: string; phoneE164: string; queueId: number }) => request<{ accepted: boolean; duplicate: boolean; conversationId: string; normalized: { type: string; body?: string; externalContactId: string } }>(`/v1/panel/channels/${channelId}/simulate-inbound`, { method: 'POST', body: JSON.stringify(input) }),
  saveChatAiProcessing: (channelId: string, input: { processingDelayMs: number }) => request(`/v1/panel/channels/${channelId}/processing`, { method: 'PUT', body: JSON.stringify(input) }),
  saveChatAiChannelConnection: (channelId: string, input: { backendUrl: string; apiToken: string; queueId: number; processingDelayMs: number }) => request<ChatAiConnectionResult>(`/v1/panel/channels/${channelId}/chatai`, { method: 'POST', body: JSON.stringify(input) }),
  testChatAiChannelConnection: (channelId: string, phoneE164: string) => request<{ connected: boolean; recipientExists: boolean; jid: string | null }>(`/v1/panel/channels/${channelId}/chatai/test`, { method: 'POST', body: JSON.stringify({ phoneE164 }) }),
  syncChatAiTags: (channelId: string) => request<ChatAiTagSyncResult>(`/v1/panel/channels/${channelId}/chatai/tags/sync`, { method: 'POST' }),
  aiConfiguration: () => request<AiConfiguration>('/v1/panel/ai/configuration'),
  agentPromptVersions: () => request<{ data: AgentPromptVersion[] }>('/v1/panel/ai/prompt-versions'),
  createAgentPromptVersion: (input: { agentKey: AgentKey; instructions: string }) => request<AgentPromptVersion>('/v1/panel/ai/prompt-versions', { method: 'POST', body: JSON.stringify(input) }),
  activateAgentPromptVersion: (promptId: string) => request<AgentPromptVersion>(`/v1/panel/ai/prompt-versions/${promptId}/activate`, { method: 'POST' }),
  saveOpenAiKey: (apiKey: string) => request<{ configured: boolean }>('/v1/panel/ai/openai-key', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  updateAiAgent: (agentKey: AgentKey, input: { model: AgentModel; enabled: boolean }) => request<AiAgentConfiguration>(`/v1/panel/ai/agents/${agentKey}`, { method: 'PUT', body: JSON.stringify(input) }),
  testPrompt: (agentKey: AgentKey, message: string, promptVersionId?: string) => request<PromptTestResult>('/v1/panel/ai/prompt-test', { method: 'POST', body: JSON.stringify({ agentKey, message, promptVersionId }) })
};
