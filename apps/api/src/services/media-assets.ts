import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool, withTransaction } from '../db/client.js';
import { config } from '../config.js';
import { mediaStorage } from '../storage/media-storage.js';

const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxImageBytes = 10 * 1024 * 1024;

export const productUploadIntentSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().refine((value) => allowedMimeTypes.has(value), 'Use JPEG, PNG ou WebP.'),
  byteSize: z.number().int().min(1).max(maxImageBytes),
  altText: z.string().max(500).optional(),
  position: z.number().int().min(0).max(10_000).default(0)
});

function extensionFor(mimeType: string): string {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[mimeType];
}

function safeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export async function createProductUploadIntent(organizationId: string, productId: string, input: z.infer<typeof productUploadIntentSchema>) {
  if (!config.MEDIA_S3_BUCKET) throw new Error('media_storage_not_configured');
  const product = await pool.query('SELECT 1 FROM products WHERE id = $1 AND organization_id = $2', [productId, organizationId]);
  if (!product.rowCount) throw new Error('product_not_found');

  const assetId = randomUUID();
  const storageKey = `organizations/${organizationId}/products/${productId}/${assetId}.${extensionFor(input.mimeType)}`;
  const upload = await mediaStorage().createUploadAuthorization(storageKey, input.mimeType);
  await pool.query(
    `INSERT INTO media_assets (id, organization_id, product_id, bucket, storage_key, original_filename, mime_type, byte_size, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [assetId, organizationId, productId, config.MEDIA_S3_BUCKET, storageKey, safeFilename(input.filename), input.mimeType, input.byteSize, JSON.stringify({ altText: input.altText, position: input.position })]
  );
  return { assetId, storageKey, uploadUrl: upload.uploadUrl, headers: upload.headers, expiresInSeconds: config.MEDIA_PRESIGNED_URL_TTL_SECONDS };
}

export async function completeProductUpload(organizationId: string, productId: string, assetId: string) {
  const asset = await pool.query<{ storage_key: string; mime_type: string; byte_size: number; status: string; metadata: { altText?: string; position?: number } }>(
    `SELECT ma.storage_key, ma.mime_type, ma.byte_size, ma.status, ma.metadata
       FROM media_assets ma
       JOIN products p ON p.id = ma.product_id
      WHERE ma.id = $1 AND ma.organization_id = $2 AND p.id = $3`,
    [assetId, organizationId, productId]
  );
  if (!asset.rowCount) throw new Error('media_asset_not_found');
  if (asset.rows[0].status === 'ready') return findLinkedMedia(productId, assetId);
  const object = await mediaStorage().verifyObject(asset.rows[0].storage_key);
  if (!allowedMimeTypes.has(object.contentType) || object.byteSize > maxImageBytes) throw new Error('media_object_invalid');

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE media_assets SET status = 'ready', mime_type = $2, byte_size = $3, uploaded_at = now() WHERE id = $1`,
      [assetId, object.contentType, object.byteSize]
    );
    const linked = await client.query(
      `INSERT INTO product_media (product_id, asset_id, storage_key, public_url, mime_type, alt_text, position)
       SELECT $1, ma.id, ma.storage_key, NULL, ma.mime_type,
              COALESCE(ma.metadata->>'altText', ma.original_filename), COALESCE((ma.metadata->>'position')::integer, 0)
         FROM media_assets ma WHERE ma.id = $2
       ON CONFLICT (product_id, storage_key) DO UPDATE SET asset_id = EXCLUDED.asset_id
       RETURNING id, product_id, asset_id, storage_key, public_url, mime_type, alt_text, position, created_at`,
      [productId, assetId]
    );
    return linked.rows[0];
  });
}

async function findLinkedMedia(productId: string, assetId: string) {
  const result = await pool.query(
    `SELECT id, product_id, asset_id, storage_key, public_url, mime_type, alt_text, position, created_at
       FROM product_media WHERE product_id = $1 AND asset_id = $2`,
    [productId, assetId]
  );
  if (!result.rowCount) throw new Error('media_asset_not_linked');
  return result.rows[0];
}

export async function createMediaAssetReadUrl(organizationId: string, assetId: string): Promise<{ url: string; mimeType: string }> {
  const asset = await pool.query<{ storage_key: string; mime_type: string }>(
    `SELECT storage_key, mime_type FROM media_assets
      WHERE id = $1 AND organization_id = $2 AND status = 'ready'`,
    [assetId, organizationId]
  );
  if (!asset.rowCount) throw new Error('media_asset_not_available');
  return { url: await mediaStorage().createReadUrl(asset.rows[0].storage_key), mimeType: asset.rows[0].mime_type };
}

export async function attachReadUrls<T extends { media: Array<{ assetId?: string | null; url?: string | null }> }>(products: T[]): Promise<T[]> {
  return Promise.all(products.map(async (product) => ({
    ...product,
    media: await Promise.all(product.media.map(async (media) => {
      if (!media.assetId || media.url) return media;
      try {
        const asset = await pool.query<{ organization_id: string }>('SELECT organization_id FROM media_assets WHERE id = $1 AND status = \'ready\'', [media.assetId]);
        if (!asset.rowCount) return media;
        return { ...media, url: (await createMediaAssetReadUrl(asset.rows[0].organization_id, media.assetId)).url };
      } catch {
        return media;
      }
    }))
  })));
}
