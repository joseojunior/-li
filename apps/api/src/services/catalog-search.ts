import { z } from 'zod';
import { pool } from '../db/client.js';
import { attachReadUrls } from './media-assets.js';

export const catalogSearchSchema = z.object({
  organizationId: z.string().uuid(),
  query: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(30),
  available: z.boolean().optional(),
  inStock: z.boolean().optional(),
  category: z.string().min(1).max(255).optional(),
  tags: z.array(z.string().min(1).max(64)).max(30).optional(),
  minPriceCents: z.number().int().nonnegative().optional(),
  maxPriceCents: z.number().int().nonnegative().optional(),
  // A API de embeddings será ligada posteriormente pelo worker. O campo já
  // permite combinar similaridade vetorial com texto sem acoplar o catálogo
  // a um provedor de IA.
  queryEmbedding: z.array(z.number().finite()).min(1).max(4096).optional()
}).superRefine((value, ctx) => {
  if (value.minPriceCents !== undefined && value.maxPriceCents !== undefined && value.minPriceCents > value.maxPriceCents) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxPriceCents'], message: 'O preço máximo deve ser maior ou igual ao mínimo.' });
  }
});

export type CatalogSearchInput = z.infer<typeof catalogSearchSchema>;

export async function searchCatalog(input: CatalogSearchInput) {
  const query = input.query?.trim() || null;
  const result = await pool.query(
    `WITH parameters AS (
       SELECT NULLIF($2::text, '') AS search_text,
              websearch_to_tsquery('portuguese', COALESCE(NULLIF($2::text, ''), '')) AS ts_query,
              $9::real[] AS query_embedding
     ),
     scored AS (
       SELECT p.id, p.sku, p.name, p.description, p.category, p.tags, p.price_cents, p.currency, p.available,
              p.inventory_quantity, p.inventory_updated_at, p.source, p.last_synced_at,
              ts_rank_cd(
                to_tsvector('portuguese', coalesce(p.name, '') || ' ' || coalesce(p.description, '') || ' ' || coalesce(p.category, '') || ' ' || array_to_string(p.tags, ' ')),
                parameters.ts_query
              ) AS text_score,
              GREATEST(
                similarity(lower(p.name), lower(COALESCE(parameters.search_text, ''))),
                similarity(lower(COALESCE(p.category, '')), lower(COALESCE(parameters.search_text, ''))),
                similarity(lower(array_to_string(p.tags, ' ')), lower(COALESCE(parameters.search_text, '')))
              ) AS fuzzy_score,
              COALESCE(vector_score.score, 0) AS vector_score
         FROM products p
         CROSS JOIN parameters
         LEFT JOIN product_embeddings pe ON pe.product_id = p.id AND pe.status = 'ready'
         LEFT JOIN LATERAL (
           SELECT SUM(item.value * query_item.value) /
                  NULLIF(SQRT(SUM(item.value * item.value)) * SQRT(SUM(query_item.value * query_item.value)), 0) AS score
             FROM unnest(pe.embedding) WITH ORDINALITY AS item(value, position)
             JOIN unnest(parameters.query_embedding) WITH ORDINALITY AS query_item(value, position)
               ON query_item.position = item.position
            WHERE cardinality(pe.embedding) = cardinality(parameters.query_embedding)
         ) vector_score ON true
        WHERE p.organization_id = $1
          AND ($3::boolean IS NULL OR p.available = $3)
          AND ($4::boolean IS NULL OR $4 = false OR p.inventory_quantity IS NULL OR p.inventory_quantity > 0)
          AND ($5::text IS NULL OR p.category ILIKE $5)
          AND ($6::text[] IS NULL OR p.tags @> $6)
          AND ($7::integer IS NULL OR p.price_cents >= $7)
          AND ($8::integer IS NULL OR p.price_cents <= $8)
     )
     SELECT scored.*,
            (scored.text_score * 0.65 + scored.fuzzy_score * 0.20 + scored.vector_score * 0.15) AS search_score,
            COALESCE(jsonb_agg(jsonb_build_object('id', pm.id, 'assetId', pm.asset_id, 'url', pm.public_url, 'mimeType', pm.mime_type, 'altText', pm.alt_text, 'position', pm.position)
              ORDER BY pm.position) FILTER (WHERE pm.id IS NOT NULL), '[]'::jsonb) AS media
       FROM scored
       CROSS JOIN parameters
       LEFT JOIN product_media pm ON pm.product_id = scored.id
      WHERE parameters.search_text IS NULL
         OR scored.text_score > 0
         OR scored.fuzzy_score >= 0.10
         OR scored.vector_score >= 0.62
      GROUP BY scored.id, scored.sku, scored.name, scored.description, scored.category, scored.tags, scored.price_cents,
               scored.currency, scored.available, scored.inventory_quantity, scored.inventory_updated_at, scored.source,
               scored.last_synced_at, scored.text_score, scored.fuzzy_score, scored.vector_score
      ORDER BY scored.available DESC,
               search_score DESC,
               scored.name ASC
      LIMIT $10`,
    [
      input.organizationId,
      query,
      input.available ?? null,
      input.inStock ?? null,
      input.category ? `%${input.category}%` : null,
      input.tags?.length ? input.tags : null,
      input.minPriceCents ?? null,
      input.maxPriceCents ?? null,
      input.queryEmbedding ?? null,
      input.limit
    ]
  );
  return attachReadUrls(result.rows);
}

export async function markProductEmbeddingPending(organizationId: string, productId: string): Promise<void> {
  await pool.query(
    `INSERT INTO product_embeddings (product_id, organization_id, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (product_id) DO UPDATE
       SET status = 'pending', error_code = NULL, updated_at = now()`,
    [productId, organizationId]
  );
}

/** Recebe vetores apenas de um worker confiável; nenhuma rota de painel expõe este método. */
export async function saveProductEmbedding(input: { organizationId: string; productId: string; model: string; embedding: number[]; contentHash: string }) {
  const embedding = z.array(z.number().finite()).min(1).max(4096).parse(input.embedding);
  const result = await pool.query(
    `UPDATE product_embeddings
        SET model = $3, embedding = $4, content_hash = $5, status = 'ready', error_code = NULL, indexed_at = now(), updated_at = now()
      WHERE product_id = $1 AND organization_id = $2
      RETURNING product_id, model, status, indexed_at`,
    [input.productId, input.organizationId, input.model, embedding, input.contentHash]
  );
  if (!result.rowCount) throw new Error('product_embedding_not_found');
  return result.rows[0];
}
