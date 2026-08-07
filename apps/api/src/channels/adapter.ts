export type OutboundMessage = {
  channelId: string;
  conversationId: string;
  messageId: string;
  provider: string;
  recipient: string;
  body: string;
  media: Array<{ url: string; mimeType?: string; filename?: string }>;
};

export type DeliveryResult =
  | { status: 'sent'; providerMessageIds: string[] }
  | { status: 'waiting_configuration'; reason: string };

export interface ChannelAdapter {
  send(message: OutboundMessage): Promise<DeliveryResult>;
}

/** Safe default until the WhatsApp/channel credentials and signature rules are configured. */
export class UnconfiguredChannelAdapter implements ChannelAdapter {
  async send(message: OutboundMessage): Promise<DeliveryResult> {
    return { status: 'waiting_configuration', reason: `channel_provider_not_configured:${message.provider}` };
  }
}
