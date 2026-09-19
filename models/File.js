const mongoose = require("mongoose");

const fileSchema = new mongoose.Schema({
    transferId: {
        type: String,
        required: true
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

    filePath: {
        type: String,
        required: true
    },

    downloaded: {
        type: Boolean,
        default: false
    },

    downloadedAt: {
        type: Date,
        default: null
    },

    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model("File", fileSchema);