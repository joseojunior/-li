import type { ChannelAdapter, DeliveryResult, OutboundMessage } from './adapter.js';

export type ChatAiConnection = {
  backendUrl: string;
  apiToken: string;
  queueId: number;
};

export type ChatAiTagCandidate = {
  name: string;
  color?: string;
};

function normalizedRecipient(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 20) throw new Error('invalid_chat_ai_recipient');
  return digits;
}

function urlFor(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.atendeai.chat')) throw new Error('invalid_chat_ai_backend_url');
  return new URL(path, url.href.endsWith('/') ? url.href : `${url.href}/`).toString();
}

function mediaType(mimeType: string | undefined): 'image' | 'audio' | 'video' | 'document' {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('audio/')) return 'audio';
  if (mimeType?.startsWith('video/')) return 'video';
  return 'document';
}

function mediaEndpoint(type: ReturnType<typeof mediaType>): string {
  return ({
    image: '/api/messages/sendurlimage',
    audio: '/api/messages/sendurlaudio',
    video: '/api/messages/sendurlvideo',
    document: '/api/messages/sendurldocument'
  } as const)[type];
}

function responseId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['id', 'messageId', 'message_id', 'key']) {
    if (typeof record[key] === 'string' || typeof record[key] === 'number') return String(record[key]);
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function remoteContactRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const value = record(payload);
  if (!value) return [];
  for (const key of ['data', 'contacts', 'tickets', 'rows']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function remoteTagCandidate(value: unknown): ChatAiTagCandidate | null {
  if (typeof value === 'string' && value.trim()) return { name: value.trim().slice(0, 100) };
  const tag = record(value);
  if (!tag) return null;
  const name = nonEmptyString(tag.name) ?? nonEmptyString(tag.label) ?? nonEmptyString(tag.title) ?? nonEmptyString(tag.tag) ?? nonEmptyString(tag.value);
  if (!name) return null;
  const color = nonEmptyString(tag.color);
  return { name: name.slice(0, 100), color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined };
}

function collectRemoteTags(payload: unknown): ChatAiTagCandidate[] {
  const byName = new Map<string, ChatAiTagCandidate>();
  // The provider documents a whole-contact response. Never let an unexpectedly
  // large tenant response turn this manual import into unbounded processing.
  for (const item of remoteContactRows(payload).slice(0, 25_000)) {
    const contact = record(item);
    const tags = Array.isArray(contact?.tags) ? contact.tags : Array.isArray(record(contact?.contact)?.tags) ? record(contact?.contact)?.tags as unknown[] : [];
    for (const value of tags) {
      const tag = remoteTagCandidate(value);
      if (!tag) continue;
      const key = tag.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
      if (!byName.has(key)) byName.set(key, tag);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

export class ChatAiChannelAdapter implements ChannelAdapter {
  constructor(private readonly connection: ChatAiConnection) {}

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    const recipient = normalizedRecipient(message.recipient);
    const responseIds: string[] = [];
    if (message.body.trim()) {
      responseIds.push(await this.post('/api/messages/send', {
        number: recipient,
        openTicket: 0,
        queueId: this.connection.queueId,
        body: message.body
      }));
    }
    for (const media of message.media) {
      const type = mediaType(media.mimeType);
      responseIds.push(await this.post(mediaEndpoint(type), {
        number: recipient,
        mimetype: media.mimeType,
        caption: message.body || undefined,
        filename: media.filename || undefined,
        ...(type === 'audio' ? { ptt: false } : {}),
        body: media.url
      }));
    }
    if (!responseIds.length) throw new Error('empty_outbound_message');
    return { status: 'sent', providerMessageIds: responseIds };
  }

  async validateRecipient(recipient: string): Promise<{ exists: boolean; jid?: string }> {
    const payload = await this.request('/api/isValid', { number: normalizedRecipient(recipient) });
    if (!payload || typeof payload !== 'object') throw new Error('chatai_invalid_validation_response');
    const record = payload as Record<string, unknown>;
    if (typeof record.exists !== 'boolean') throw new Error('chatai_invalid_validation_response');
    return { exists: record.exists, jid: typeof record.jid === 'string' ? record.jid : undefined };
  }

  /**
   * AtendeAI currently documents tags inside the contact/ticket response rather
   * than a dedicated tag-catalog endpoint. This reads that response and returns
   * only tag labels/colors; contact data is deliberately discarded.
   */
  async listConversationTags(): Promise<ChatAiTagCandidate[]> {
    const payload = await this.request('/api/contacts/all', undefined, 'GET');
    return collectRemoteTags(payload);
  }

  private async post(path: string, body: Record<string, unknown>): Promise<string> {
    const payload = await this.request(path, body);
    return responseId(payload) ?? crypto.randomUUID();
  }

  private async request(path: string, body?: Record<string, unknown>, method = 'POST'): Promise<unknown> {
    const response = await fetch(urlFor(this.connection.backendUrl, path), {
      method,
      headers: { authorization: `Bearer ${this.connection.apiToken}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`chatai_request_failed:${response.status}`);
    return payload;
  }
}
