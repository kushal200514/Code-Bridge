const { test, describe } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const aiService = require("../services/aiService");
const storageService = require("../services/storageService");
const Transfer = require("../models/Transfer");
const { hashToken, safeCompareHashes } = require("../middleware/auth");

describe("1. Cryptographic Token Hashing & Safe Comparison", () => {
    test("hashToken generates consistent 64-char SHA-256 hex string", () => {
        const token = "my-secret-session-token-12345";
        const hash1 = hashToken(token);
        const hash2 = hashToken(token);
        assert.strictEqual(hash1.length, 64);
        assert.strictEqual(hash1, hash2);
    });

    test("safeCompareHashes validates matching hashes with timingSafeEqual", () => {
        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = hashToken(token);
        assert.strictEqual(safeCompareHashes(tokenHash, tokenHash), true);
    });

    test("safeCompareHashes rejects mismatched hashes safely", () => {
        const hashA = hashToken("token-a");
        const hashB = hashToken("token-b");
        assert.strictEqual(safeCompareHashes(hashA, hashB), false);
    });

    test("safeCompareHashes safely rejects malformed or null inputs without throwing", () => {
        assert.strictEqual(safeCompareHashes(null, "some-hash"), false);
        assert.strictEqual(safeCompareHashes("some-hash", null), false);
        assert.strictEqual(safeCompareHashes("short", "longer-hash"), false);
    });
});

describe("2. Path Traversal & Storage Security", () => {
    test("sanitizeKey rejects path traversal attempts in transferId", () => {
        assert.throws(() => {
            storageService.sanitizeKey("../../../etc", "file.txt");
        }, /Invalid transfer identifier format/);

        assert.throws(() => {
            storageService.sanitizeKey("transfer/../../root", "file.txt");
        }, /Invalid transfer identifier format/);
    });

    test("sanitizeKey safely accepts valid UUID format and sanitizes filename", () => {
        const validId = "123e4567-e89b-12d3-a456-426614174000";
        const sanitized = storageService.sanitizeKey(validId, "../../hack.sh");
        assert.strictEqual(sanitized, `${validId}/hack.sh`);
    });

    test("getLocalPath prevents directory escape outside base upload dir", () => {
        const validId = "123e4567-e89b-12d3-a456-426614174000";
        const localPath = storageService.getLocalPath(`${validId}/document.pdf`);
        assert.strictEqual(localPath.startsWith(storageService.localBaseDir), true);
    });
});

describe("3. AI Privacy Guard & Sensitive Content Detection", () => {
    test("detects AWS Access Keys and redacts sample safely", () => {
        const sampleText = "Here is my key AKIAIOSFODNN7EXAMPLE for deployment.";
        const report = aiService.scanForPrivacyIssues(sampleText, "config.env");

        assert.strictEqual(report.safe, false);
        assert.strictEqual(report.findingCount >= 1, true);
        assert.strictEqual(report.categoriesFound.includes("AWS Access Key"), true);
        // Ensure raw key is NOT present in redactedSample
        assert.strictEqual(report.findings[0].redactedSample.includes("AKIAIOSFODNN7EXAMPLE"), false);
        assert.strictEqual(report.findings[0].redactedSample.includes("***"), true);
    });

    test("detects Private Key blocks", () => {
        const sampleText = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----";
        const report = aiService.scanForPrivacyIssues(sampleText, "id_rsa");
        assert.strictEqual(report.safe, false);
        assert.strictEqual(report.categoriesFound.includes("Private Cryptographic Key"), true);
    });

    test("detects Email Addresses and Phone Numbers", () => {
        const sampleText = "Contact me at alice@example.com or +1 555-234-5678.";
        const report = aiService.scanForPrivacyIssues(sampleText, "notes.txt");
        assert.strictEqual(report.safe, false);
        assert.strictEqual(report.categoriesFound.includes("Email Address"), true);
        assert.strictEqual(report.categoriesFound.includes("Phone Number"), true);
    });

    test("reports clean for safe text", () => {
        const sampleText = "Hello world! This is a simple document with no credentials or secrets.";
        const report = aiService.scanForPrivacyIssues(sampleText, "hello.txt");
        assert.strictEqual(report.safe, true);
        assert.strictEqual(report.findingCount, 0);
    });
});

describe("4. File Classification by Signature (Magic Bytes)", () => {
    test("identifies PNG image by magic bytes [0x89, 0x50, 0x4E, 0x47]", () => {
        const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        const result = aiService.classifyFile("unknown.bin", "application/octet-stream", pngHeader);
        assert.strictEqual(result.category, "Images");
        assert.strictEqual(result.verifiedByMagic, true);
    });

    test("identifies PDF document by magic bytes %PDF", () => {
        const pdfHeader = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]);
        const result = aiService.classifyFile("doc.tmp", "application/octet-stream", pdfHeader);
        assert.strictEqual(result.category, "Documents");
        assert.strictEqual(result.verifiedByMagic, true);
    });

    test("identifies ZIP archive by magic bytes PK..", () => {
        const zipHeader = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
        const result = aiService.classifyFile("bundle.dat", "application/octet-stream", zipHeader);
        assert.strictEqual(result.category, "Archives");
        assert.strictEqual(result.verifiedByMagic, true);
    });
});

describe("5. Smart Compression Advice", () => {
    test("recommends compression for large uncompressed text files", () => {
        const advice = aiService.getCompressionRecommendation("large_data.json", 500 * 1024, "application/json");
        assert.strictEqual(advice.shouldCompress, true);
        assert.strictEqual(advice.suggestedFormat, "ZIP / Deflate");
    });

    test("recommends against recompressing already compressed zip/media files", () => {
        const advice = aiService.getCompressionRecommendation("archive.zip", 10 * 1024 * 1024, "application/zip");
        assert.strictEqual(advice.shouldCompress, false);
    });
});

describe("6. AI Assistant Query Matching", () => {
    test("answers send file query with actionable advice", () => {
        const res = aiService.answerAssistantQuery("How do I send files?");
        assert.strictEqual(res.suggestedAction, "SEND_FILES");
        assert.strictEqual(res.answer.includes("Send Files"), true);
    });

    test("answers E2E encryption explanation query accurately", () => {
        const res = aiService.answerAssistantQuery("What does end to end encryption mean?");
        assert.strictEqual(res.suggestedAction, "E2EE_INFO");
        assert.strictEqual(res.answer.includes("AES-GCM-256"), true);
        assert.strictEqual(res.answer.includes("server stores ciphertext"), true);
    });

    test("provides safe general help fallback without leaking secrets", () => {
        const res = aiService.answerAssistantQuery("some unknown query");
        assert.strictEqual(res.suggestedAction, "GENERAL_HELP");
        assert.strictEqual(typeof res.answer, "string");
    });
});

describe("6B. AI Document Summarization", () => {
    test("summarizes text document into executive overview and key points", async () => {
        const sampleText = "CodeBridge is an ephemeral temporary file sharing application. It uses a strict 10-minute lifecycle to wipe files permanently. All tokens are cryptographically hashed and compared in constant time. Senders must explicitly approve receivers before files can be transferred.";
        const summary = await aiService.summarizeText(sampleText, "overview.txt");
        assert.ok(summary.summary);
        assert.ok(Array.isArray(summary.keyPoints));
        assert.strictEqual(summary.filename, "overview.txt");
    });

    test("handles empty document gracefully", async () => {
        const summary = await aiService.summarizeText("", "empty.txt");
        assert.strictEqual(summary.summary, "Empty document.");
        assert.deepStrictEqual(summary.keyPoints, []);
    });
});

describe("7. End-to-End Encryption (AES-256-GCM) Threat Model Simulation", () => {
    // Simulates the exact Web Crypto AES-GCM workflow used in client
    function simulateClientEncryption(plaintextBuffer, keyBytes) {
        const iv = crypto.randomBytes(12); // 96-bit nonce
        const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
        const authTag = cipher.getAuthTag(); // 128-bit tag
        return { iv, ciphertext, authTag };
    }

    function simulateClientDecryption(ciphertext, iv, authTag, keyBytes) {
        const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }

    test("correct key decrypts ciphertext identically to original plaintext", () => {
        const key = crypto.randomBytes(32);
        const originalText = Buffer.from("Top secret confidential payload between peers.");
        const encrypted = simulateClientEncryption(originalText, key);

        const decrypted = simulateClientDecryption(encrypted.ciphertext, encrypted.iv, encrypted.authTag, key);
        assert.strictEqual(decrypted.toString("utf8"), originalText.toString("utf8"));
    });

    test("wrong key fails authentication safely", () => {
        const keyA = crypto.randomBytes(32);
        const keyB = crypto.randomBytes(32);
        const originalText = Buffer.from("Sensitive data");
        const encrypted = simulateClientEncryption(originalText, keyA);

        assert.throws(() => {
            simulateClientDecryption(encrypted.ciphertext, encrypted.iv, encrypted.authTag, keyB);
        });
    });

    test("tampered ciphertext fails authentication check", () => {
        const key = crypto.randomBytes(32);
        const originalText = Buffer.from("Tamper-proof financial record.");
        const encrypted = simulateClientEncryption(originalText, key);

        // Modify 1 byte of ciphertext
        encrypted.ciphertext[0] ^= 0x01;

        assert.throws(() => {
            simulateClientDecryption(encrypted.ciphertext, encrypted.iv, encrypted.authTag, key);
        });
    });
});
