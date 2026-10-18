/**
 * CodeBridge AI Intelligence & Privacy Guard Service
 * Modular service supporting regex heuristics, magic byte classification,
 * consent-based AI summarization, smart search, and FAQ assistant.
 */

// Common regex patterns for heuristic privacy scanning
const SENSITIVE_PATTERNS = [
    {
        type: "AWS Access Key",
        severity: "Critical",
        regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
        description: "AWS Access Key ID detected"
    },
    {
        type: "Private Cryptographic Key",
        severity: "Critical",
        regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
        description: "Private encryption/signing key block found"
    },
    {
        type: "Generic API Key / Secret Token",
        severity: "High",
        regex: /(?:api[_-]?key|secret|auth[_-]?token|bearer)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,80})['"]?/gi,
        description: "Potential API key or authentication token assignment"
    },
    {
        type: "JSON Web Token (JWT)",
        severity: "High",
        regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_\-]{10,}/g,
        description: "JWT session or access token structure found"
    },
    {
        type: "Email Address",
        severity: "Medium",
        regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        description: "Personally identifiable email address"
    },
    {
        type: "Phone Number",
        severity: "Medium",
        regex: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
        description: "Potential phone number"
    },
    {
        type: "US Social Security Number",
        severity: "Critical",
        regex: /\b\d{3}-\d{2}-\d{4}\b/g,
        description: "SSN format detected"
    },
    {
        type: "Credit Card Number",
        severity: "Critical",
        regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g,
        description: "Credit card number pattern"
    }
];

// File signature magic bytes for robust classification
const FILE_SIGNATURES = [
    { category: "Images", mime: "image/jpeg", magic: [0xFF, 0xD8, 0xFF] },
    { category: "Images", mime: "image/png", magic: [0x89, 0x50, 0x4E, 0x47] },
    { category: "Images", mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
    { category: "Images", mime: "image/webp", magic: [0x52, 0x49, 0x46, 0x46], offset: 0, subCheck: "WEBP" },
    { category: "Documents", mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] },
    { category: "Archives", mime: "application/zip", magic: [0x50, 0x4B, 0x03, 0x04] },
    { category: "Archives", mime: "application/gzip", magic: [0x1F, 0x8B] },
    { category: "Videos", mime: "video/mp4", magic: [0x00, 0x00, 0x00], offset: 0, subCheck: "ftyp" },
    { category: "Audio", mime: "audio/mpeg", magic: [0x49, 0x44, 0x33] } // ID3
];

class AIService {
    constructor() {
        this.provider = (process.env.AI_PROVIDER || "mock").toLowerCase();
        this.openAiKey = process.env.OPENAI_API_KEY || null;
        this.geminiKey = process.env.GEMINI_API_KEY || null;
    }

    /**
     * Inspect file category via magic bytes and filename extension
     */
    classifyFile(filename, mimeType, buffer) {
        let category = "Other";
        const ext = filename.split(".").pop()?.toLowerCase() || "";

        // Check magic bytes first if buffer is available
        if (buffer && buffer.length >= 4) {
            for (const sig of FILE_SIGNATURES) {
                let matches = true;
                for (let i = 0; i < sig.magic.length; i++) {
                    if (buffer[i] !== sig.magic[i]) {
                        matches = false;
                        break;
                    }
                }
                if (matches) {
                    if (sig.subCheck === "WEBP" && buffer.toString("utf8", 8, 12) !== "WEBP") {
                        matches = false;
                    }
                    if (sig.subCheck === "ftyp" && buffer.toString("utf8", 4, 8) !== "ftyp") {
                        matches = false;
                    }
                }
                if (matches) {
                    category = sig.category;
                    return { category, mimeType: sig.mime, verifiedByMagic: true };
                }
            }
        }

        // Secondary fallback: known extensions and MIME types
        if (["js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "go", "rs", "html", "css", "json", "yaml", "yml", "sql", "sh"].includes(ext)) {
            category = "Code";
        } else if (["txt", "md", "pdf", "rtf", "odt"].includes(ext)) {
            category = "Documents";
        } else if (["doc", "docx"].includes(ext)) {
            category = "Documents";
        } else if (["xls", "xlsx", "csv", "tsv"].includes(ext)) {
            category = "Spreadsheets";
        } else if (["ppt", "pptx", "key"].includes(ext)) {
            category = "Presentations";
        } else if (["zip", "tar", "gz", "7z", "rar"].includes(ext)) {
            category = "Archives";
        } else if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext)) {
            category = "Images";
        } else if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) {
            category = "Videos";
        } else if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) {
            category = "Audio";
        }

        return { category, mimeType: mimeType || "application/octet-stream", verifiedByMagic: false };
    }

    /**
     * Privacy Guard scanner
     * Detects sensitive tokens, PII, keys without persisting raw secret values
     */
    scanForPrivacyIssues(contentString, filename = "") {
        if (!contentString || typeof contentString !== "string") {
            return {
                safe: true,
                checked: true,
                findingCount: 0,
                findings: [],
                categoriesFound: []
            };
        }

        // Truncate inspection to 500KB to prevent CPU exhaustion
        const inspectSlice = contentString.slice(0, 500 * 1024);
        const findings = [];
        const categoriesFound = new Set();

        for (const pattern of SENSITIVE_PATTERNS) {
            pattern.regex.lastIndex = 0;
            let match;
            let countForPattern = 0;

            while ((match = pattern.regex.exec(inspectSlice)) !== null && countForPattern < 5) {
                countForPattern++;
                categoriesFound.add(pattern.type);

                // Calculate line number safely
                const beforeMatch = inspectSlice.substring(0, match.index);
                const lineNumber = beforeMatch.split("\n").length;

                findings.push({
                    type: pattern.type,
                    severity: pattern.severity,
                    description: pattern.description,
                    line: lineNumber,
                    // Redact secret: show only first 2 and last 2 chars
                    redactedSample: match[0].length > 6 
                        ? `${match[0].slice(0, 2)}***${match[0].slice(-2)}` 
                        : "***"
                });
            }
        }

        return {
            safe: findings.length === 0,
            checked: true,
            findingCount: findings.length,
            findings,
            categoriesFound: Array.from(categoriesFound),
            filename
        };
    }

    /**
     * Document Summarization (consent-based)
     */
    async summarizeText(text, filename = "") {
        if (!text || text.trim().length === 0) {
            return { summary: "Empty document.", keyPoints: [] };
        }

        const safeSnippet = text.slice(0, 8000); // 8KB cap

        // Local Heuristic / Extractive Fallback Summary
        const sentences = safeSnippet.split(/(?<=[.?!])\s+/).filter(s => s.trim().length > 20);
        const keySentences = sentences.slice(0, 4);

        const fallbackSummary = {
            provider: "heuristic",
            summary: keySentences.length > 0 
                ? keySentences.join(" ") 
                : safeSnippet.slice(0, 200) + "...",
            keyPoints: sentences.slice(0, 3).map(s => s.trim()),
            wordCount: text.split(/\s+/).length,
            filename
        };

        // If real provider is configured and available
        if (this.provider === "openai" && this.openAiKey) {
            try {
                const response = await fetch("https://api.openai.com/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${this.openAiKey}`
                    },
                    body: JSON.stringify({
                        model: "gpt-4o-mini",
                        messages: [
                            { role: "system", content: "You are a concise file summarizer. Return a 2-3 sentence overview followed by 3 key bullet points." },
                            { role: "user", content: `Summarize this document (${filename}):\n\n${safeSnippet}` }
                        ],
                        max_tokens: 250
                    })
                });
                if (response.ok) {
                    const data = await response.json();
                    const text = data.choices?.[0]?.message?.content || "";
                    return {
                        provider: "openai",
                        summary: text,
                        keyPoints: keySentences,
                        filename
                    };
                }
            } catch (err) {
                console.warn("External AI summarization failed, using heuristic fallback:", err.message);
            }
        }

        return fallbackSummary;
    }

    /**
     * Smart Search across transfer file metadata and permitted previews
     */
    searchFiles(query, filesList) {
        if (!query || !filesList || !Array.isArray(filesList)) {
            return filesList || [];
        }

        const q = query.toLowerCase().trim();
        return filesList.filter(file => {
            const nameMatch = file.originalName?.toLowerCase().includes(q) || file.name?.toLowerCase().includes(q);
            const categoryMatch = file.category?.toLowerCase().includes(q);
            const mimeMatch = file.mimeType?.toLowerCase().includes(q) || file.type?.toLowerCase().includes(q);
            const summaryMatch = file.summary?.toLowerCase().includes(q);

            return nameMatch || categoryMatch || mimeMatch || summaryMatch;
        });
    }

    /**
     * AI Transfer Assistant (In-App FAQ and Guided Explanations)
     */
    answerAssistantQuery(query, transferState = {}) {
        const q = (query || "").toLowerCase();

        if (q.includes("send") || q.includes("how to send")) {
            return {
                answer: "To send files: 1. Click 'Send Files' to create a transfer. 2. A 6-digit code and QR code are generated. 3. Select your files. 4. When the receiver connects and enters the code, approve their join request. 5. Upload your files for them to download.",
                suggestedAction: "SEND_FILES"
            };
        }

        if (q.includes("code") || q.includes("6-digit") || q.includes("temporary code")) {
            return {
                answer: "The 6-digit code is a temporary cryptographic identifier used to pair the sender and receiver. It expires automatically in 10 minutes and does not grant direct file download without sender approval.",
                suggestedAction: "INFO"
            };
        }

        if (q.includes("expire") || q.includes("expired") || q.includes("time")) {
            return {
                answer: "All transfers on CodeBridge have a strict 10-minute lifetime. Once expired, all metadata and files on disk or object storage are immediately purged by automated background cleanup.",
                suggestedAction: "EXPIRY_INFO"
            };
        }

        if (q.includes("approval") || q.includes("approve") || q.includes("reject")) {
            return {
                answer: "Sender Approval prevents unauthorized users from grabbing files even if they guess a code. When a receiver enters your code, you receive a real-time notification to either Approve or Reject their connection.",
                suggestedAction: "APPROVAL_INFO"
            };
        }

        if (q.includes("revoke") || q.includes("stop") || q.includes("cancel")) {
            return {
                answer: "You can revoke access at any time using the 'Revoke Access' button. This immediately terminates the receiver's session, disconnects their real-time socket, and renders all download tokens permanently invalid.",
                suggestedAction: "REVOKE_ACTION"
            };
        }

        if (q.includes("encryption") || q.includes("e2e") || q.includes("end-to-end") || q.includes("e2ee")) {
            return {
                answer: "In End-to-End Encryption (E2EE) mode, your files are encrypted directly in your browser using AES-GCM-256 before being uploaded. The server stores ciphertext and never possesses your decryption key.",
                suggestedAction: "E2EE_INFO"
            };
        }

        if (q.includes("privacy guard") || q.includes("sensitive") || q.includes("scan")) {
            return {
                answer: "AI Privacy Guard scans your files locally before upload to detect exposed API keys, private keys, passwords, emails, phone numbers, and SSNs. You can review any findings before sending.",
                suggestedAction: "PRIVACY_GUARD_INFO"
            };
        }

        if (q.includes("compression") || q.includes("compress") || q.includes("size")) {
            return {
                answer: "Smart Compression analyzes your files and suggests compressing text, log, JSON, and uncompressed documents before upload to save bandwidth and transfer faster.",
                suggestedAction: "COMPRESSION_INFO"
            };
        }

        return {
            answer: "CodeBridge provides secure, temporary, accountless file sharing with 10-minute expiry, sender approval, one-time downloads, and optional browser-based end-to-end encryption. Ask me about sending files, receiver approval, encryption, or file privacy!",
            suggestedAction: "GENERAL_HELP"
        };
    }

    /**
     * Smart Compression Recommendations
     */
    getCompressionRecommendation(filename, sizeBytes, mimeType = "") {
        const ext = filename.split(".").pop()?.toLowerCase() || "";
        const alreadyCompressedExts = ["zip", "gz", "7z", "rar", "jpg", "jpeg", "png", "webp", "mp4", "mkv", "mp3", "aac"];
        const compressibleExts = ["txt", "log", "json", "csv", "xml", "html", "css", "js", "ts", "svg", "bmp", "pdf", "docx"];

        const isAlreadyCompressed = alreadyCompressedExts.includes(ext) || mimeType.includes("zip") || mimeType.includes("jpeg") || mimeType.includes("mp4");
        const isCompressible = compressibleExts.includes(ext) || mimeType.includes("text") || mimeType.includes("json");

        if (isAlreadyCompressed) {
            return {
                shouldCompress: false,
                reason: "This file format is already compressed. Recompressing will not yield significant size reduction.",
                estimatedSavings: "0%"
            };
        }

        if (isCompressible && sizeBytes > 50 * 1024) { // > 50KB
            const estimatedPercent = ext === "csv" || ext === "json" || ext === "txt" ? 65 : 40;
            return {
                shouldCompress: true,
                reason: `Uncompressed document format detected. Compressing before transfer could save approximately ~${estimatedPercent}% in size and bandwidth.`,
                estimatedSavings: `~${estimatedPercent}%`,
                suggestedFormat: "ZIP / Deflate"
            };
        }

        return {
            shouldCompress: false,
            reason: "File size is small enough that compression overhead provides minimal benefit.",
            estimatedSavings: "<5%"
        };
    }
}

module.exports = new AIService();
