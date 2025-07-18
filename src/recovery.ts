import { S3Client, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { pipeline } from "stream/promises";
import { CloudStorageConfig } from "./backup.js";

export interface RecoveryConfig {
    cloudStorage: CloudStorageConfig;
    localPath: string;
    autoRecover?: boolean; // Automatically recover missing files
    recoveryTimeout?: number; // Timeout for recovery operations (default: 30000ms)
}

export interface RecoveryResult {
    success: boolean;
    recovered: string[];
    failed: string[];
    totalFiles: number;
    duration: number;
}

export interface FileRecoveryInfo {
    key: string;
    exists: boolean;
    size?: number;
    lastModified?: Date;
    recovered?: boolean;
}

export class DataRecovery {
    private s3Client!: S3Client;
    private config: RecoveryConfig;

    constructor(config: RecoveryConfig) {
        this.config = config;
        this.initializeCloudStorage();
    }

    private initializeCloudStorage(): void {
        try {
            const clientConfig: any = {
                region: this.config.cloudStorage.region,
                credentials: {
                    accessKeyId: this.config.cloudStorage.accessKeyId,
                    secretAccessKey: this.config.cloudStorage.secretAccessKey,
                },
            };

            // Configure for Cloudflare R2 or custom endpoints
            if (this.config.cloudStorage.endpoint) {
                clientConfig.endpoint = this.config.cloudStorage.endpoint;
                clientConfig.forcePathStyle = true; // Required for R2
            }

            this.s3Client = new S3Client(clientConfig);
        } catch (error) {
            throw new Error(`Failed to initialize cloud storage for recovery: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private getCloudKey(filename: string): string {
        const prefix = this.config.cloudStorage.pathPrefix || 'tero-backups';
        const dbName = this.config.localPath.split('/').pop() || 'database';
        return `${prefix}/${dbName}/${filename}`;
    }

    async checkFileInCloud(key: string): Promise<FileRecoveryInfo> {
        try {
            const cloudKey = this.getCloudKey(`${key}.json`);

            const headCommand = new HeadObjectCommand({
                Bucket: this.config.cloudStorage.bucket,
                Key: cloudKey
            });

            const response = await this.s3Client.send(headCommand);

            return {
                key,
                exists: true,
                size: response.ContentLength,
                lastModified: response.LastModified
            };
        } catch (error: any) {
            if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
                return {
                    key,
                    exists: false
                };
            }
            throw new Error(`Failed to check file in cloud: ${error.message}`);
        }
    }

    async recoverSingleFile(key: string): Promise<boolean> {
        try {
            const cloudKey = this.getCloudKey(`${key}.json`);
            const localFilePath = join(this.config.localPath, `${key}.json`);

            // Ensure local directory exists
            const localDir = dirname(localFilePath);
            if (!existsSync(localDir)) {
                mkdirSync(localDir, { recursive: true });
            }

            const getCommand = new GetObjectCommand({
                Bucket: this.config.cloudStorage.bucket,
                Key: cloudKey
            });

            const response = await this.s3Client.send(getCommand);

            if (!response.Body) {
                throw new Error('No data received from cloud storage');
            }

            // Stream the file to local storage
            const writeStream = createWriteStream(localFilePath);
            await pipeline(response.Body as any, writeStream);

            return true;
        } catch (error: any) {
            if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
                return false;
            }
            return false;
        }
    }

    async recoverFromArchive(archiveName?: string): Promise<RecoveryResult> {
        const startTime = Date.now();
        const recovered: string[] = [];
        const failed: string[] = [];

        try {
            // List available archives if no specific archive is provided
            if (!archiveName) {
                const archives = await this.listAvailableArchives();
                if (archives.length === 0) {
                    throw new Error('No backup archives found in cloud storage');
                }
                // Use the most recent archive
                archiveName = archives[0];
            }

            const cloudKey = this.getCloudKey(archiveName);
            const localArchivePath = join(this.config.localPath, archiveName);

            // Download the archive
            const downloadSuccess = await this.downloadFile(cloudKey, localArchivePath);

            if (!downloadSuccess) {
                throw new Error(`Failed to download archive: ${archiveName}`);
            }

            // Extract the archive
            const extractSuccess = await this.extractArchive(localArchivePath);

            if (extractSuccess) {
                recovered.push(archiveName);
            } else {
                failed.push(archiveName);
            }

            const duration = Date.now() - startTime;
            return {
                success: recovered.length > 0,
                recovered,
                failed,
                totalFiles: 1,
                duration
            };
        } catch (error) {
            const duration = Date.now() - startTime;

            return {
                success: false,
                recovered,
                failed: [archiveName || 'unknown'],
                totalFiles: 1,
                duration
            };
        }
    }

    async recoverIndividualFiles(keys?: string[]): Promise<RecoveryResult> {
        const startTime = Date.now();
        const recovered: string[] = [];
        const failed: string[] = [];

        try {
            // If no keys provided, list all available files
            if (!keys || keys.length === 0) {
                keys = await this.listAvailableFiles();
                if (keys.length === 0) {
                    throw new Error('No backup files found in cloud storage');
                }
            }

            // Recover each file
            for (const key of keys) {
                const success = await this.recoverSingleFile(key);
                if (success) {
                    recovered.push(key);
                } else {
                    failed.push(key);
                }
            }

            const duration = Date.now() - startTime;

            return {
                success: recovered.length > 0,
                recovered,
                failed,
                totalFiles: keys.length,
                duration
            };
        } catch (error) {
            const duration = Date.now() - startTime;

            return {
                success: false,
                recovered,
                failed: keys || [],
                totalFiles: keys?.length || 0,
                duration
            };
        }
    }

    async listAvailableArchives(): Promise<string[]> {
        try {
            const prefix = this.getCloudKey('');

            const listCommand = new ListObjectsV2Command({
                Bucket: this.config.cloudStorage.bucket,
                Prefix: prefix,
                MaxKeys: 100
            });

            const response = await this.s3Client.send(listCommand);

            if (!response.Contents) {
                return [];
            }

            // Filter for archive files and sort by date (newest first)
            const archives = response.Contents
                .filter((obj: any) => obj.Key && obj.Key.endsWith('.tar.gz'))
                .sort((a: any, b: any) => {
                    const dateA = a.LastModified?.getTime() || 0;
                    const dateB = b.LastModified?.getTime() || 0;
                    return dateB - dateA; // Newest first
                })
                .map((obj: any) => obj.Key!.split('/').pop()!)
                .filter(Boolean);

            return archives;
        } catch (error) {
            return [];
        }
    }

    async listAvailableFiles(): Promise<string[]> {
        try {
            const prefix = this.getCloudKey('');

            const listCommand = new ListObjectsV2Command({
                Bucket: this.config.cloudStorage.bucket,
                Prefix: prefix,
                MaxKeys: 1000
            });

            const response = await this.s3Client.send(listCommand);

            if (!response.Contents) {
                return [];
            }

            // Filter for JSON files and extract keys
            const files = response.Contents
                .filter((obj: any) => obj.Key && obj.Key.endsWith('.json'))
                .map((obj: any) => {
                    const filename = obj.Key!.split('/').pop()!;
                    return filename.replace('.json', '');
                })
                .filter(Boolean);

            return files;
        } catch (error) {
            return [];
        }
    }

    private async downloadFile(cloudKey: string, localPath: string): Promise<boolean> {
        try {
            const getCommand = new GetObjectCommand({
                Bucket: this.config.cloudStorage.bucket,
                Key: cloudKey
            });

            const response = await this.s3Client.send(getCommand);

            if (!response.Body) {
                return false;
            }

            // Ensure local directory exists
            const localDir = dirname(localPath);
            if (!existsSync(localDir)) {
                mkdirSync(localDir, { recursive: true });
            }

            const writeStream = createWriteStream(localPath);
            await pipeline(response.Body as any, writeStream);

            return true;
        } catch (error) {
            return false;
        }
    }

    private async extractArchive(archivePath: string): Promise<boolean> {
        try {
            const tar = await import('tar');

            await tar.extract({
                file: archivePath,
                cwd: this.config.localPath,
                strip: 1 // Remove the top-level directory from the archive
            });

            return true;
        } catch (error) {
            return false;
        }
    }

    async testCloudConnection(): Promise<{ success: boolean; message: string }> {
        try {
            const listCommand = new ListObjectsV2Command({
                Bucket: this.config.cloudStorage.bucket,
                MaxKeys: 1
            });

            await this.s3Client.send(listCommand);
            return { success: true, message: 'Cloud storage connection successful' };
        } catch (error) {
            return {
                success: false,
                message: `Cloud storage connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async getRecoveryInfo(): Promise<{
        cloudFiles: number;
        localFiles: number;
        missingLocally: string[];
        availableForRecovery: string[];
    }> {
        try {
            const cloudFiles = await this.listAvailableFiles();
            const localFiles: string[] = [];

            // Check which files exist locally
            for (const key of cloudFiles) {
                const localPath = join(this.config.localPath, `${key}.json`);
                if (existsSync(localPath)) {
                    localFiles.push(key);
                }
            }

            const missingLocally = cloudFiles.filter(key => !localFiles.includes(key));

            return {
                cloudFiles: cloudFiles.length,
                localFiles: localFiles.length,
                missingLocally,
                availableForRecovery: cloudFiles
            };
        } catch (error) {
            return {
                cloudFiles: 0,
                localFiles: 0,
                missingLocally: [],
                availableForRecovery: []
            };
        }
    }
}