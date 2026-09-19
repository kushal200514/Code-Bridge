const mongoose = require("mongoose");

const transferSchema = new mongoose.Schema({
    transferId: {
        type: String,
        required: true,
        unique: true
    },

    code: {
        type: String,
        required: true
    },

    sessionToken: {
        type: String,
        required: true
    },

    status: {
        type: String,
        default: "waiting"
    },

    createdAt: {
        type: Date,
        default: Date.now
    },
    
    receiverToken: {
    type: String,
    default: null
    },

    expiresAt: {
        type: Date,
        required: true
    }
});

module.exports = mongoose.model("Transfer", transferSchema);