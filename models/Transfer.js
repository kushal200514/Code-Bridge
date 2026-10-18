const mongoose = require("mongoose");
const crypto = require("crypto");
const { TransferStore } = require("./dbStore");

const transferSchema = new mongoose.Schema({
    transferId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },

    code: {
        type: String,
        required: true,
        index: true
    },

    // Session token hash (SHA-256) for secure lookup & zero plaintext storage
    sessionTokenHash: {
        type: String,
        required: true,
        index: true
    },

    // Legacy plaintext field retained for backward compatibility during transition
    sessionToken: {
        type: String,
        default: null
    },

    // Transfer status: waiting, pending_approval, connected, rejected, expired, revoked
    status: {
        type: String,
        enum: ["waiting", "pending_approval", "connected", "rejected", "expired", "revoked"],
        default: "waiting",
        index: true
    },

    // Receiver token hash (SHA-256)
    receiverTokenHash: {
        type: String,
        default: null,
        index: true
    },

    // Legacy receiver token
    receiverToken: {
        type: String,
        default: null
    },

    // Optional password protection
    isPasswordProtected: {
        type: Boolean,
        default: false
    },

    passwordHash: {
        type: String,
        default: null
    },

    // End-to-end encryption flag (ciphertext on server, key in client)
    isE2EE: {
        type: Boolean,
        default: false
    },

    // Brute-force protection tracking
    failedCodeAttempts: {
        type: Number,
        default: 0
    },

    lastFailedAttemptAt: {
        type: Date,
        default: null
    },

    // Storage provider used for transfer ('local' | 's3')
    storageProvider: {
        type: String,
        default: "local"
    },

    // Quotas and limits
    maxFiles: {
        type: Number,
        default: 10
    },

    maxTotalSizeBytes: {
        type: Number,
        default: 250 * 1024 * 1024 // 250 MB
    },

    totalBytesUploaded: {
        type: Number,
        default: 0
    },

    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },

    expiresAt: {
        type: Date,
        required: true,
        index: true
    }
});

// Helper static method to compute token hash
transferSchema.statics.hashToken = function (token) {
    if (!token) return null;
    return crypto.createHash("sha256").update(token).digest("hex");
};

// Safe timing-equal check helper
transferSchema.statics.safeTokenCompare = function (knownHash, providedToken) {
    if (!knownHash || !providedToken) return false;
    const providedHash = crypto.createHash("sha256").update(providedToken).digest("hex");
    if (knownHash.length !== providedHash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(knownHash, "hex"), Buffer.from(providedHash, "hex"));
};

const MongooseTransfer = mongoose.models.Transfer || mongoose.model("Transfer", transferSchema);

const AdaptiveTransfer = {
    create: (data) => TransferStore.create(data),
    findOne: (query) => TransferStore.findOne(query),
    find: (query) => TransferStore.find(query),
    deleteOne: (query) => TransferStore.deleteOne(query),
    hashToken: MongooseTransfer.hashToken,
    safeTokenCompare: MongooseTransfer.safeTokenCompare
};

module.exports = AdaptiveTransfer;