const crypto = require("crypto");
const Transfer = require("../models/Transfer");

function hashToken(token) {
    if (!token || typeof token !== "string") return null;
    return crypto.createHash("sha256").update(token.trim()).digest("hex");
}

function safeCompareHashes(hashA, hashB) {
    if (!hashA || !hashB) return false;
    if (typeof hashA !== "string" || typeof hashB !== "string") return false;
    if (hashA.length !== 64 || hashB.length !== 64) return false;
    const hexRegex = /^[0-9a-fA-F]{64}$/;
    if (!hexRegex.test(hashA) || !hexRegex.test(hashB)) return false;
    const bufA = Buffer.from(hashA, "hex");
    const bufB = Buffer.from(hashB, "hex");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function extractToken(req, type = "session") {
    // 1. Authorization: Bearer <token>
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        return authHeader.substring(7).trim();
    }

    // 2. Custom header
    const customHeader = type === "session" 
        ? req.headers["x-session-token"] 
        : req.headers["x-receiver-token"];
    if (customHeader) return customHeader.trim();

    // 3. Request body or query params
    if (type === "session") {
        return req.body?.session_token || req.query?.session_token;
    } else {
        return req.body?.receiver_token || req.query?.receiver_token;
    }
}

// Sender Authorization Middleware
async function verifySender(req, res, next) {
    try {
        const transferId = req.params.transferId || req.body?.transferId;
        const token = extractToken(req, "session");

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Sender session token required"
            });
        }

        if (!transferId) {
            return res.status(400).json({
                success: false,
                message: "Transfer ID is required"
            });
        }

        const transfer = await Transfer.findOne({ transferId });
        if (!transfer) {
            return res.status(404).json({
                success: false,
                message: "Transfer not found"
            });
        }

        // Expiry check
        if (new Date() > transfer.expiresAt) {
            transfer.status = "expired";
            await transfer.save();
            return res.status(410).json({
                success: false,
                message: "Transfer has expired"
            });
        }

        if (transfer.status === "revoked") {
            return res.status(403).json({
                success: false,
                message: "Transfer has been revoked"
            });
        }

        const tokenHash = hashToken(token);
        const isMatch = transfer.sessionTokenHash 
            ? safeCompareHashes(transfer.sessionTokenHash, tokenHash)
            : (transfer.sessionToken === token);

        if (!isMatch) {
            return res.status(403).json({
                success: false,
                message: "Invalid session token"
            });
        }

        req.transfer = transfer;
        next();
    } catch (err) {
        console.error("verifySender error:", err.message);
        res.status(500).json({ success: false, message: "Authorization verification failed" });
    }
}

// Receiver Authorization Middleware
async function verifyReceiver(req, res, next) {
    try {
        const transferId = req.params.transferId || req.body?.transferId;
        const token = extractToken(req, "receiver");

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Receiver token required"
            });
        }

        if (!transferId) {
            return res.status(400).json({
                success: false,
                message: "Transfer ID is required"
            });
        }

        const transfer = await Transfer.findOne({ transferId });
        if (!transfer) {
            return res.status(404).json({
                success: false,
                message: "Transfer not found"
            });
        }

        // Expiry check
        if (new Date() > transfer.expiresAt) {
            transfer.status = "expired";
            await transfer.save();
            return res.status(410).json({
                success: false,
                message: "Transfer has expired"
            });
        }

        if (transfer.status === "revoked") {
            return res.status(403).json({
                success: false,
                message: "Transfer access has been revoked"
            });
        }

        // Access control: only CONNECTED receivers can access protected data
        if (transfer.status === "pending_approval") {
            return res.status(403).json({
                success: false,
                status: "pending_approval",
                message: "Join request is waiting for sender approval"
            });
        }

        if (transfer.status === "rejected") {
            return res.status(403).json({
                success: false,
                status: "rejected",
                message: "Join request was rejected by sender"
            });
        }

        if (transfer.status !== "connected") {
            return res.status(403).json({
                success: false,
                message: "Transfer is not active"
            });
        }

        const tokenHash = hashToken(token);
        const isMatch = transfer.receiverTokenHash
            ? safeCompareHashes(transfer.receiverTokenHash, tokenHash)
            : (transfer.receiverToken === token);

        if (!isMatch) {
            return res.status(403).json({
                success: false,
                message: "Invalid receiver token"
            });
        }

        req.transfer = transfer;
        next();
    } catch (err) {
        console.error("verifyReceiver error:", err.message);
        res.status(500).json({ success: false, message: "Receiver authorization failed" });
    }
}

module.exports = {
    hashToken,
    safeCompareHashes,
    verifySender,
    verifyReceiver
};
