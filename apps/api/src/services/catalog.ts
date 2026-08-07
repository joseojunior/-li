import { z } from 'zod';
import { pool } from '../db/client.js';
import { attachReadUrls } from './media-assets.js';
import { markProductEmbeddingPending, searchCatalog } from './catalog-search.js';

export const productInputSchema = z.object({
  organizationId: z.string().uuid(),
  sku: z.string().min(1).max(100),
  name: z.string().min(2).max(255),
  description: z.string().max(10_000).optional(),
  category: z.string().max(255).optional(),
  tags: z.array(z.string().min(1).max(64)).max(30).default([]),
  priceCents: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).default('BRL'),
  available: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const productUpdateSchema = productInputSchema.omit({ organizationId: true }).partial().refine((value) => Object.keys(value).length > 0, 'Informe ao menos um campo para atualizar.');

export const productMediaInputSchema = z.object({
  storageKey: z.string().min(1).max(1_000),
  publicUrl: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'A URL da mídia deve usar HTTPS.'),
  mimeType: z.string().min(3).max(120),
  altText: z.string().max(500).optional(),
  position: z.number().int().min(0).max(10_000).default(0)
});

export async function createProduct(input: z.infer<typeof productInputSchema>) {
  const result = await pool.query(
    `INSERT INTO products (organization_id, sku, name, description, category, tags, price_cents, currency, available, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, organization_id, sku, name, description, category, tags, price_cents, currency, available, created_at`,
    [
      input.organizationId,
      input.sku,
      input.name,
      input.description ?? null,
      input.category ?? null,
      input.tags,
      input.priceCents ?? null,
      input.currency.toUpperCase(),
      input.available,
      JSON.stringify(input.metadata)
    ]
  );
  await markProductEmbeddingPending(input.organizationId, result.rows[0].id);
  return result.rows[0];
}

export async function updateProduct(organizationId: string, productId: string, input: z.infer<typeof productUpdateSchema>) {
  const fields: string[] = [];
  const values: unknown[] = [];
  const assign = (column: string, value: unknown) => { values.push(value); fields.push(`${column} = $${values.length}`); };
  if (input.sku !== undefined) assign('sku', input.sku);
  if (input.name !== undefined) assign('name', input.name);
  if (input.description !== undefined) assign('description', input.description ?? null);
  if (input.category !== undefined) assign('category', input.category ?? null);
  if (input.tags !== undefined) assign('tags', input.tags);
  if (input.priceCents !== undefined) assign('price_cents', input.priceCents ?? null);
  if (input.currency !== undefined) assign('currency', input.currency.toUpperCase());
  if (input.available !== undefined) assign('available', input.available);
  if (input.metadata !== undefined) assign('metadata', JSON.stringify(input.metadata));
  values.push(productId, organizationId);
  const result = await pool.query(
    `UPDATE products SET ${fields.join(', ')}, updated_at = now()
      WHERE id = $${values.length - 1} AND organization_id = $${values.length}
      RETURNING id, organization_id, sku, name, description, category, tags, price_cents, currency, available, updated_at`,
    values
  );
  if (!result.rowCount) throw new Error('product_not_found');
  await markProductEmbeddingPending(organizationId, productId);
  return result.rows[0];
}

export async function addProductMedia(organizationId: string, productId: string, input: z.infer<typeof productMediaInputSchema>) {
  const result = await pool.query(
    `INSERT INTO product_media (product_id, storage_key, public_url, mime_type, alt_text, position)
     SELECT p.id, $3, $4, $5, $6, $7 FROM products p WHERE p.id = $1 AND p.organization_id = $2
     RETURNING id, product_id, storage_key, public_url, mime_type, alt_text, position, created_at`,
    [productId, organizationId, input.storageKey, input.publicUrl, input.mimeType, input.altText ?? null, input.position]
  );
  if (!result.rowCount) throw new Error('product_not_found');
  return result.rows[0];
}

export async function removeProductMedia(organizationId: string, productId: string, mediaId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM product_media pm USING products p
      WHERE pm.id = $1 AND pm.product_id = $2 AND p.id = pm.product_id AND p.organization_id = $3`,
    [mediaId, productId, organizationId]
  );
  return Boolean(result.rowCount);
}

export async function searchProducts(organizationId: string, query: string | undefined, limit: number) {
  return searchCatalog({ organizationId, query, limit });
}

export async function getProductMedia(organizationId: string, productId: string, options: { includeReadUrls?: boolean } = {}) {
  const result = await pool.query(
    `SELECT p.id, p.name,
            COALESCE(jsonb_agg(jsonb_build_object('id', pm.id, 'assetId', pm.asset_id, 'url', pm.public_url, 'mimeType', pm.mime_type, 'altText', pm.alt_text, 'position', pm.position)
              ORDER BY pm.position) FILTER (WHERE pm.id IS NOT NULL), '[]'::jsonb) AS media
       FROM products p
       LEFT JOIN product_media pm ON pm.product_id = p.id
      WHERE p.id = $1 AND p.organization_id = $2
      GROUP BY p.id`,
    [productId, organizationId]
  );
  if (!result.rowCount) return null;
  return options.includeReadUrls === false ? result.rows[0] : (await attachReadUrls(result.rows))[0];
}
