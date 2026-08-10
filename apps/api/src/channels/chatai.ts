import type { ChannelAdapter, DeliveryResult, OutboundMessage } from './adapter.js';

export type ChatAiConnection = {
  backendUrl: string;
  apiToken: string;
  queueId: number;
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

  private async post(path: string, body: Record<string, unknown>): Promise<string> {
    const payload = await this.request(path, body);
    return responseId(payload) ?? crypto.randomUUID();
  }

  private async request(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(urlFor(this.connection.backendUrl, path), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.connection.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`chatai_request_failed:${response.status}`);
    return payload;
  }
}
