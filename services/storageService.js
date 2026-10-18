const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

class StorageService {
    constructor() {
        this.provider = (process.env.STORAGE_PROVIDER || "local").toLowerCase();
        this.localBaseDir = path.resolve(__dirname, "..", process.env.UPLOAD_DIR || "uploads");

        // Ensure base upload dir exists for local provider
        if (this.provider === "local" && !fs.existsSync(this.localBaseDir)) {
            fs.mkdirSync(this.localBaseDir, { recursive: true });
        }

        // Initialize S3 client only if credentials and endpoint are present
        if (this.provider === "s3") {
            const config = {
                region: process.env.S3_REGION || "auto",
                credentials: {
                    accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
                    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || ""
                }
            };
            if (process.env.S3_ENDPOINT) {
                config.endpoint = process.env.S3_ENDPOINT;
            }
            this.s3Client = new S3Client(config);
            this.bucket = process.env.S3_BUCKET || "codebridge-transfers";
        }
    }

    // Path traversal defense: validates transferId and key names strictly
    sanitizeKey(transferId, key) {
        const uuidRegex = /^[0-9a-fA-F-]{8,64}$/;
        if (!uuidRegex.test(transferId)) {
            throw new Error("Invalid transfer identifier format");
        }
        // Key should only contain safe characters (alphanumeric, dash, underscore, dot)
        const cleanKey = path.basename(key).replace(/[^a-zA-Z0-9._-]/g, "_");
        return `${transferId}/${cleanKey}`;
    }

    getLocalPath(storageKey) {
        const safeKey = storageKey.split("/").map(seg => path.basename(seg)).join(path.sep);
        const resolvedPath = path.resolve(this.localBaseDir, safeKey);
        // Ensure path is strictly inside localBaseDir
        if (!resolvedPath.startsWith(this.localBaseDir)) {
            throw new Error("Path traversal attempt detected");
        }
        return resolvedPath;
    }

    async saveFile({ transferId, filename, buffer, filePath, mimeType }) {
        const storageKey = this.sanitizeKey(transferId, filename);

        if (this.provider === "s3" && this.s3Client) {
            const body = buffer || fs.readFileSync(filePath);
            await this.s3Client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: storageKey,
                Body: body,
                ContentType: mimeType || "application/octet-stream"
            }));

            // Remove temporary local file if created by multer
            if (filePath && fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (_) {}
            }

            return {
                storageKey,
                storageProvider: "s3",
                filePath: storageKey // S3 key
            };
        }

        // Default: local filesystem
        const targetPath = this.getLocalPath(storageKey);
        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        if (buffer) {
            fs.writeFileSync(targetPath, buffer);
        } else if (filePath && filePath !== targetPath) {
            // Move or copy from multer temp path
            fs.copyFileSync(filePath, targetPath);
            try { fs.unlinkSync(filePath); } catch (_) {}
        }

        return {
            storageKey,
            storageProvider: "local",
            filePath: targetPath
        };
    }

    async getFileStream(storageKey) {
        if (this.provider === "s3" && this.s3Client) {
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: storageKey
            });
            const response = await this.s3Client.send(command);
            return response.Body; // Readable stream
        }

        const localPath = this.getLocalPath(storageKey);
        if (!fs.existsSync(localPath)) {
            throw new Error("File not found on storage");
        }
        return fs.createReadStream(localPath);
    }

    async deleteFile(storageKey) {
        try {
            if (this.provider === "s3" && this.s3Client) {
                await this.s3Client.send(new DeleteObjectCommand({
                    Bucket: this.bucket,
                    Key: storageKey
                }));
                return true;
            }

            const localPath = this.getLocalPath(storageKey);
            if (fs.existsSync(localPath)) {
                fs.unlinkSync(localPath);
            }
            return true;
        } catch (err) {
            console.error(`Error deleting storage object ${storageKey}:`, err.message);
            return false;
        }
    }

    async deleteTransferFolder(transferId) {
        try {
            const uuidRegex = /^[0-9a-fA-F-]{8,64}$/;
            if (!uuidRegex.test(transferId)) return;

            if (this.provider === "s3" && this.s3Client) {
                const list = await this.s3Client.send(new ListObjectsV2Command({
                    Bucket: this.bucket,
                    Prefix: `${transferId}/`
                }));
                if (list.Contents && list.Contents.length > 0) {
                    for (const obj of list.Contents) {
                        await this.deleteFile(obj.Key);
                    }
                }
                return;
            }

            const folderPath = path.resolve(this.localBaseDir, transferId);
            if (folderPath.startsWith(this.localBaseDir) && fs.existsSync(folderPath)) {
                fs.rmSync(folderPath, { recursive: true, force: true });
            }
        } catch (err) {
            console.error(`Error cleaning transfer folder ${transferId}:`, err.message);
        }
    }
}

module.exports = new StorageService();
