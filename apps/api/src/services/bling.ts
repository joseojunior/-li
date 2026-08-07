import { z } from 'zod';
import { pool, withTransaction } from '../db/client.js';

export const catalogSyncRequestSchema = z.object({
  mode: z.enum(['full', 'incremental']).default('incremental')
});

export async function requestBlingCatalogSync(organizationId: string, mode: z.infer<typeof catalogSyncRequestSchema>['mode']) {
  return withTransaction(async (client) => {
    // Serializa solicitações por organização antes de criar a execução.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`bling-catalog:${organizationId}`]);
    const active = await client.query<{ integration_job_id: string }>(
      `SELECT integration_job_id FROM catalog_sync_runs
        WHERE organization_id = $1 AND provider = 'bling' AND status IN ('queued', 'running')
        ORDER BY created_at DESC LIMIT 1`,
      [organizationId]
    );
    if (active.rowCount) return { integrationJobId: active.rows[0].integration_job_id, duplicate: true };

    const job = await client.query<{ id: string }>(
      `INSERT INTO integration_jobs (organization_id, provider, operation, payload)
       VALUES ($1, 'bling', 'catalog.sync', $2) RETURNING id`,
      [organizationId, JSON.stringify({ mode })]
    );
    await client.query(
      `INSERT INTO catalog_sync_runs (organization_id, integration_job_id, mode)
       VALUES ($1, $2, $3)`,
      [organizationId, job.rows[0].id, mode]
    );
    return { integrationJobId: job.rows[0].id, duplicate: false };
  });
}

export async function markBlingJobWaitingConfiguration(jobId: string): Promise<void> {
  await markBlingJobBlocked(jobId, 'integration_not_configured');
}

export async function listBlingCatalogSyncRuns(organizationId: string, limit = 12) {
  const result = await pool.query(
    `SELECT csr.id, csr.integration_job_id, csr.mode, csr.status, csr.products_seen,
            csr.products_upserted, csr.products_deactivated, csr.error_code,
            csr.error_detail, csr.started_at, csr.completed_at, csr.created_at,
            csr.updated_at
       FROM catalog_sync_runs csr
      WHERE csr.organization_id = $1 AND csr.provider = 'bling'
      ORDER BY csr.created_at DESC
      LIMIT $2`,
    [organizationId, limit]
  );
  return result.rows;
}

async function markBlingJobBlocked(jobId: string, errorCode: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE integration_jobs
          SET status = 'waiting_configuration', updated_at = now(), error_code = $2
        WHERE id = $1 AND provider = 'bling' AND status = 'queued'`,
      [jobId, errorCode]
    );
    await client.query(
      `UPDATE catalog_sync_runs
          SET status = 'waiting_configuration', error_code = $2, updated_at = now()
        WHERE integration_job_id = $1 AND status = 'queued'`,
      [jobId, errorCode]
    );
  });
}

/**
 * Ponto de entrada do worker. O adaptador OAuth/HTTP será habilitado somente
 * depois do cadastro seguro da conexão Bling; até lá não há chamada externa.
 */
export async function processBlingCatalogSync(jobId: string): Promise<void> {
  const connection = await pool.query(
    `SELECT 1
       FROM integration_jobs j
       JOIN bling_connections b ON b.organization_id = j.organization_id
      WHERE j.id = $1 AND j.provider = 'bling' AND j.operation = 'catalog.sync' AND b.status = 'active'`,
    [jobId]
  );
  if (!connection.rowCount) return markBlingJobWaitingConfiguration(jobId);

  // Não é permitido simular uma sincronização: uma conexão ativa só será
  // possível quando o adaptador OAuth e o cliente Bling forem ativados.
  await markBlingJobBlocked(jobId, 'catalog_sync_adapter_not_enabled');
}
