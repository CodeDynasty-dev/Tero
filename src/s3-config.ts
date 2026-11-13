import type { CloudStorageConfig } from './backup.js';

/** Shared S3 client options: endpoint/path-style for R2 and custom endpoints, and request timeouts. */
export function buildS3ClientConfig(cloudConfig: CloudStorageConfig): any {
  const clientConfig: any = {
    region: cloudConfig.region,
    credentials: {
      accessKeyId: cloudConfig.accessKeyId,
      secretAccessKey: cloudConfig.secretAccessKey,
    },
    requestHandler: {
      requestTimeout: cloudConfig.requestTimeoutMs ?? 30_000,
      connectionTimeout: cloudConfig.connectionTimeoutMs ?? 5_000,
      // Without this the SDK only logs a warning on timeout and keeps waiting.
      throwOnRequestTimeout: true,
    },
  };
  if (cloudConfig.endpoint) {
    clientConfig.endpoint = cloudConfig.endpoint;
    clientConfig.forcePathStyle = true; // Required for R2
  }
  return clientConfig;
}
