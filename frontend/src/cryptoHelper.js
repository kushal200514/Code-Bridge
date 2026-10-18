/**
 * Client-Side End-to-End Encryption & Privacy Utilities
 * Implements Web Crypto API (AES-GCM 256-bit) and in-browser privacy scanning.
 */

// Convert ArrayBuffer to Base64URL string
export function bufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Convert Base64URL string to ArrayBuffer
export function base64UrlToBuffer(base64url) {
    let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) {
        base64 += "=";
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Generate a cryptographically secure 256-bit AES-GCM key
 */
export async function generateE2EEKey() {
    const key = await window.crypto.subtle.generateKey(
        {
            name: "AES-GCM",
            length: 256
        },
        true,
        ["encrypt", "decrypt"]
    );

    const exportedRaw = await window.crypto.subtle.exportKey("raw", key);
    const keyString = bufferToBase64Url(exportedRaw);

    return {
        keyObject: key,
        keyString
    };
}

/**
 * Import a Base64URL key string into a CryptoKey object
 */
export async function importE2EEKey(keyString) {
    const rawBuffer = base64UrlToBuffer(keyString);
    return await window.crypto.subtle.importKey(
        "raw",
        rawBuffer,
        {
            name: "AES-GCM",
            length: 256
        },
        false,
        ["decrypt"]
    );
}

/**
 * Encrypt a File or Blob in the browser
 * Output structure: [12-byte IV] + [AES-GCM Ciphertext + 16-byte Auth Tag]
 */
export async function encryptFile(file, cryptoKey) {
    const arrayBuffer = await file.arrayBuffer();
    const iv = window.crypto.getRandomValues(new Uint8Array(12)); // 96-bit nonce

    const ciphertext = await window.crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv: iv
        },
        cryptoKey,
        arrayBuffer
    );

    // Combine IV (12 bytes) and ciphertext into a single binary Blob
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);

    return new Blob([combined], { type: "application/octet-stream" });
}

/**
 * Decrypt a downloaded binary Blob using the provided CryptoKey or KeyString
 */
export async function decryptFileBlob(encryptedBlob, keyInput) {
    let keyObject = keyInput;
    if (typeof keyInput === "string") {
        keyObject = await importE2EEKey(keyInput);
    }

    const fullBuffer = await encryptedBlob.arrayBuffer();
    if (fullBuffer.byteLength < 28) {
        throw new Error("Invalid encrypted payload size");
    }

    // Extract 12-byte IV and ciphertext
    const iv = new Uint8Array(fullBuffer.slice(0, 12));
    const ciphertext = fullBuffer.slice(12);

    const decryptedBuffer = await window.crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: iv
        },
        keyObject,
        ciphertext
    );

    return decryptedBuffer;
}

/**
 * In-Browser Client-Side Privacy Guard Scanner
 * Scans text content for credentials and PII before upload
 */
export function scanTextLocally(text, filename = "") {
    if (!text || typeof text !== "string") {
        return { safe: true, findings: [], count: 0 };
    }

    const patterns = [
        { type: "AWS Access Key", regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g, severity: "Critical" },
        { type: "Private Key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, severity: "Critical" },
        { type: "API / Bearer Token", regex: /(?:api[_-]?key|secret|auth[_-]?token|bearer)\s*[:=]\s*['"]?([a-zA-Z0-9_-]{20,80})['"]?/gi, severity: "High" },
        { type: "JSON Web Token", regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, severity: "High" },
        { type: "Email Address", regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, severity: "Medium" },
        { type: "Phone Number", regex: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, severity: "Medium" },
        { type: "US SSN", regex: /\b\d{3}-\d{2}-\d{4}\b/g, severity: "Critical" },
        { type: "Credit Card", regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/g, severity: "Critical" }
    ];

    const findings = [];
    const inspectSlice = text.slice(0, 300 * 1024); // 300KB slice

    for (const p of patterns) {
        p.regex.lastIndex = 0;
        let match;
        let c = 0;
        while ((match = p.regex.exec(inspectSlice)) !== null && c < 5) {
            c++;
            const beforeMatch = inspectSlice.substring(0, match.index);
            const line = beforeMatch.split("\n").length;
            const redacted = match[0].length > 6 
                ? `${match[0].slice(0, 2)}***${match[0].slice(-2)}` 
                : "***";

            findings.push({
                type: p.type,
                severity: p.severity,
                line,
                sample: redacted
            });
        }
    }

    return {
        safe: findings.length === 0,
        findings,
        count: findings.length,
        filename
    };
}
