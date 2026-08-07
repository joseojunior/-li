import { createHash } from 'node:crypto';
import { inboundMessageSchema, type InboundMessage } from '../services/inbound.js';

type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseEmbeddedJson(value: unknown): RecordValue | null {
  let current: unknown = value;
  for (let attempt = 0; attempt < 2 && typeof current === 'string'; attempt += 1) {
    try { current = JSON.parse(current); } catch { return null; }
  }
  return object(current);
}

function messageType(value: unknown): InboundMessage['type'] {
  return ['image', 'audio', 'video', 'document'].includes(String(value)) ? String(value) as InboundMessage['type'] : 'text';
}

function metadata(value: RecordValue, provider: string): Record<string, unknown> {
  const type = string(value.type);
  const content = type ? object(value[type]) : null;
  return {
    provider,
    providerType: type ?? 'unknown',
    providerMediaId: string(content?.id)
  };
}

function normalizeMetaCloud(raw: RecordValue): InboundMessage[] {
  const entries = Array.isArray(raw.entry) ? raw.entry : [];
  return entries.flatMap((entry) => {
    const entryRecord = object(entry);
    const changes = entryRecord && Array.isArray(entryRecord.changes) ? entryRecord.changes : [];
    return changes.flatMap((change) => {
      const value = object(object(change)?.value);
      const contacts = value && Array.isArray(value.contacts) ? value.contacts : [];
      const contact = object(contacts[0]);
      const profile = object(contact?.profile);
      const messages = value && Array.isArray(value.messages) ? value.messages : [];
      return messages.flatMap((message) => {
        const item = object(message);
        if (!item) return [];
        const id = string(item.id);
        const number = string(item.from) ?? string(contact?.wa_id);
        if (!id || !number) return [];
        const type = messageType(item.type);
        const text = object(item.text);
        const content = object(item[type]);
        const mediaUrl = string(content?.link);
        const normalized = inboundMessageSchema.safeParse({
          idempotencyKey: `chatai:${id}`,
          externalMessageId: id,
          externalContactId: number,
          contact: { name: string(profile?.name), phoneE164: `+${number}` },
          type,
          body: string(text?.body) ?? string(content?.caption),
          media: mediaUrl ? [{ url: mediaUrl, mimeType: string(content?.mime_type), filename: string(content?.filename) }] : [],
          metadata: metadata(item, 'chatai_meta_cloud')
        });
        return normalized.success ? [normalized.data] : [];
      });
    });
  });
}

function normalizeSimple(raw: RecordValue): InboundMessage[] {
  const candidate = object(raw.message) ?? object(raw.data) ?? raw;
  const id = string(candidate.id) ?? string(candidate.messageId) ?? createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
  const number = string(candidate.from) ?? string(candidate.number) ?? string(candidate.phone) ?? string(candidate.sender);
  if (!number) return [];
  const type = messageType(candidate.type);
  const content = object(candidate[type]);
  const text = object(candidate.text);
  const mediaUrl = string(candidate.url) ?? string(candidate.mediaUrl) ?? string(content?.link);
  const normalized = inboundMessageSchema.safeParse({
    idempotencyKey: `chatai:${id}`,
    externalMessageId: id,
    externalContactId: number.replace(/\D/g, ''),
    contact: { name: string(candidate.name) ?? string(candidate.pushName), phoneE164: `+${number.replace(/\D/g, '')}` },
    type,
    body: string(candidate.body) ?? string(text?.body) ?? string(content?.caption),
    media: mediaUrl ? [{ url: mediaUrl, mimeType: string(candidate.mimeType) ?? string(content?.mime_type), filename: string(candidate.fileName) ?? string(content?.filename) }] : [],
    metadata: metadata(candidate, 'chatai')
  });
  return normalized.success ? [normalized.data] : [];
}

function normalizeAtendeAiEnvelope(payload: unknown): InboundMessage[] {
  const item = Array.isArray(payload) ? object(payload[0]) : object(payload);
  const body = object(item?.body) ?? item;
  const message = object(body?.mensagem);
  if (!body || !message || message.fromMe === true || body.fromMe === true) return [];

  const serialized = parseEmbeddedJson(message.safeDataJson) ?? parseEmbeddedJson(message.dataJson);
  const rawMeta = object(serialized?.rawData);
  if (rawMeta && Array.isArray(rawMeta.entry)) {
    const metaMessages = normalizeMetaCloud(rawMeta);
    if (metaMessages.length) return metaMessages;
  }

  const contact = object(message.contact) ?? object(body.contact);
  const id = string(message.wid) ?? string(message.providerMessageId) ?? string(message.id);
  const number = string(contact?.number) ?? string(body.sender) ?? string(message.sender);
  if (!id || !number) return [];
  const type = messageType(message.mediaType ?? message.type);
  const normalized = inboundMessageSchema.safeParse({
    idempotencyKey: `chatai:${id}`,
    externalMessageId: id,
    externalContactId: number.replace(/\D/g, ''),
    contact: { name: string(contact?.name) ?? string(body.name), phoneE164: `+${number.replace(/\D/g, '')}` },
    type,
    body: string(message.body) ?? string(body.body),
    media: string(message.mediaUrl) ? [{ url: string(message.mediaUrl)!, mimeType: string(message.mediaType) }] : [],
    metadata: {
      provider: 'chatai_atendeai',
      providerType: string(message.mediaType) ?? 'text',
      ticketId: message.ticketId ?? body.chamadoId ?? null,
      queueId: message.queueId ?? body.queueId ?? null,
      action: string(body.acao) ?? null
    }
  });
  return normalized.success ? [normalized.data] : [];
}

/** Normalizes the direct ChatAI callback and the raw Meta Cloud payload seen in the current integration. */
export function normalizeChatAiWebhook(payload: unknown): InboundMessage[] {
  const atendeAi = normalizeAtendeAiEnvelope(payload);
  if (atendeAi.length) return atendeAi;
  const envelope = object(payload);
  if (!envelope) return [];
  const raw = object(envelope.rawData) ?? envelope;
  return Array.isArray(raw.entry) ? normalizeMetaCloud(raw) : normalizeSimple(raw);
}
