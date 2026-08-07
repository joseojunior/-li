import { z } from 'zod';
import type { AgentDecision } from '../agent-system/decision.js';
import { getProductMedia } from './catalog.js';
import type { OutboundMedia } from './outbound.js';

const productMediaSchema = z.object({
  assetId: z.string().uuid().nullable().optional(),
  url: z.string().url().refine((value) => new URL(value).protocol === 'https:').nullable().optional(),
  mimeType: z.string().startsWith('image/').max(120),
  altText: z.string().max(500).nullable().optional()
});

export type AgentOutboundIntent = {
  body: string;
  media: OutboundMedia[];
  requestedProductIds: string[];
  resolvedProductIds: string[];
};

/**
 * Resolves model-selected product IDs against the organization catalog. URLs
 * are intentionally created here, after authorization, not accepted from the
 * model response. Four images is a delivery guardrail for WhatsApp channels.
 */
export async function prepareAgentOutbound(organizationId: string, decision: AgentDecision): Promise<AgentOutboundIntent> {
  const requestedProductIds = [...new Set(decision.mediaProductIds)];
  const media: AgentOutboundIntent['media'] = [];
  const resolvedProductIds: string[] = [];

  for (const productId of requestedProductIds) {
    if (media.length >= 4) break;
    const product = await getProductMedia(organizationId, productId, { includeReadUrls: false });
    if (!product || !Array.isArray(product.media)) continue;
    const productMedia: Array<z.infer<typeof productMediaSchema>> = [];
    for (const item of product.media as unknown[]) {
      const parsed = productMediaSchema.safeParse(item);
      if (parsed.success) productMedia.push(parsed.data);
      if (productMedia.length >= 4 - media.length) break;
    }
    if (!productMedia.length) continue;
    resolvedProductIds.push(productId);
    for (const item of productMedia) {
      const filename = item.altText ? `${item.altText.slice(0, 120)}.jpg` : undefined;
      const outboundMedia: OutboundMedia | null = item.assetId
        ? { assetId: item.assetId, mimeType: item.mimeType, filename }
        : item.url
          ? { url: item.url, mimeType: item.mimeType, filename }
          : null;
      if (outboundMedia) media.push(outboundMedia);
    }
  }

  return { body: decision.message, media, requestedProductIds, resolvedProductIds };
}
