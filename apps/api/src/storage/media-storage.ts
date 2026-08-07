import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export type MediaObject = { key: string; contentType: string; byteSize: number };
export type UploadAuthorization = { uploadUrl: string; headers: Record<string, string> };

export interface MediaStorage {
  createUploadAuthorization(key: string, contentType: string): Promise<UploadAuthorization>;
  verifyObject(key: string): Promise<MediaObject>;
  createReadUrl(key: string): Promise<string>;
}

class DisabledMediaStorage implements MediaStorage {
  private unavailable(): never { throw new Error('media_storage_not_configured'); }
  createUploadAuthorization(): Promise<UploadAuthorization> { return Promise.reject(this.unavailable()); }
  verifyObject(): Promise<MediaObject> { return Promise.reject(this.unavailable()); }
  createReadUrl(): Promise<string> { return Promise.reject(this.unavailable()); }
}

class S3MediaStorage implements MediaStorage {
  private readonly client: S3Client;
  constructor(private readonly bucket: string) {
    this.client = new S3Client({
      region: config.MEDIA_S3_REGION,
      endpoint: config.MEDIA_S3_ENDPOINT,
      forcePathStyle: Boolean(config.MEDIA_S3_ENDPOINT),
      credentials: config.MEDIA_S3_ACCESS_KEY_ID && config.MEDIA_S3_SECRET_ACCESS_KEY ? {
        accessKeyId: config.MEDIA_S3_ACCESS_KEY_ID,
        secretAccessKey: config.MEDIA_S3_SECRET_ACCESS_KEY
      } : undefined
    });
  }

  async createUploadAuthorization(key: string, contentType: string): Promise<UploadAuthorization> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    return {
      uploadUrl: await getSignedUrl(this.client, command, { expiresIn: config.MEDIA_PRESIGNED_URL_TTL_SECONDS }),
      headers: { 'content-type': contentType }
    };
  }

  async verifyObject(key: string): Promise<MediaObject> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.ContentType || !result.ContentLength || result.ContentLength < 1) throw new Error('media_object_invalid');
    return { key, contentType: result.ContentType, byteSize: result.ContentLength };
  }

  createReadUrl(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: config.MEDIA_PRESIGNED_URL_TTL_SECONDS });
  }
}

let storage: MediaStorage | undefined;

export function mediaStorage(): MediaStorage {
  if (storage) return storage;
  if (!config.MEDIA_S3_BUCKET || !config.MEDIA_S3_ACCESS_KEY_ID || !config.MEDIA_S3_SECRET_ACCESS_KEY) {
    storage = new DisabledMediaStorage();
  } else {
    storage = new S3MediaStorage(config.MEDIA_S3_BUCKET);
  }
  return storage;
}

