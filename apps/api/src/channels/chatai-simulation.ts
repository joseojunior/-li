import { randomUUID } from 'node:crypto';

export function createChatAiSimulationPayload(input: { message: string; contactName: string; phoneE164: string; queueId: number }) {
  const phone = input.phoneE164.replace(/\D/g, '');
  const messageId = `wamid.sim.${randomUUID()}`;
  const rawData = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'simulation-waba', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '5511999990000', phone_number_id: 'simulation-phone-id' },
      contacts: [{ profile: { name: input.contactName }, wa_id: phone }],
      messages: [{ from: phone, id: messageId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: input.message } }]
    } }]}]
  };
  const serialized = JSON.stringify({ channelId: 'simulation-channel', provider: 'waba-oficial', rawData });
  return [{
    headers: { host: 'webhook.local', 'user-agent': 'lilibag-webhook-simulator', 'content-type': 'application/json' },
    params: {}, query: {},
    body: {
      mensagem: {
        id: Math.floor(Date.now() / 1_000), wid: messageId, dataJson: JSON.stringify(serialized), safeDataJson: JSON.stringify(serialized),
        fromMe: false, body: input.message, mediaType: 'conversation', ticketId: 0, queueId: input.queueId,
        contact: { name: input.contactName, number: phone }
      },
      sender: phone, name: input.contactName, fromMe: false, queueId: input.queueId, chamadoId: 0, acao: 'from_internal'
    },
    executionMode: 'simulation'
  }];
}
