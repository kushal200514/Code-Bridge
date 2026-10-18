const mongoose = require("mongoose");
const { FileStore } = require("./dbStore");

const fileSchema = new mongoose.Schema({
    transferId: {
        type: String,
        required: true,
        index: true
    },

    filename: {
        type: String,
        required: true
    },

    originalName: {
        type: String,
        required: true
    },

    mimeType: {
        type: String,
        required: true
    },

    size: {
        type: Number,
        required: true
    },

    // Storage abstraction reference
    storageKey: {
        type: String,
        required: true
    },

    storageProvider: {
        type: String,
        enum: ["local", "s3"],
        default: "local"
    },

    filePath: {
        type: String,
        required: true
    },

    // One-time download enforcement
    downloaded: {
        type: Boolean,
        default: false,
        index: true
    },

    downloadedAt: {
        type: Date,
        default: null
    },

    // End-to-end encryption indicator
    isEncrypted: {
        type: Boolean,
        default: false
    },

    // File content SHA-256 integrity hash
    sha256Hash: {
        type: String,
        default: null
    },

    // File categorization (Documents, Images, Videos, Audio, Archives, Code, Other)
    category: {
        type: String,
        default: "Other",
        index: true
    },

    // Safe summary & findings from Privacy Guard (does NOT store detected secrets or PII plaintext)
    sensitivityReport: {
        checked: { type: Boolean, default: false },
        safe: { type: Boolean, default: true },
        findingCount: { type: Number, default: 0 },
        categoriesFound: [String]
    },

    // Optional short document summary
    summary: {
        type: String,
        default: null
    },

    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    }
});

fileSchema.index({ _id: 1, transferId: 1, downloaded: 1 });

const MongooseFile = mongoose.models.File || mongoose.model("File", fileSchema);

const AdaptiveFile = {
    create: (data) => FileStore.create(data),
    findOne: (query) => FileStore.findOne(query),
    find: (query) => FileStore.find(query),
    findOneAndUpdate: (query, update, options) => FileStore.findOneAndUpdate(query, update, options),
    deleteMany: (query) => FileStore.deleteMany(query),
    countDocuments: (query) => FileStore.countDocuments(query)
};

module.exports = AdaptiveFile;