const mongoose = require("mongoose");
const crypto = require("crypto");

// In-Memory collections for zero-friction local development when MongoDB is not connected
const inMemoryTransfers = new Map();
const inMemoryFiles = new Map();

class InMemoryTransferDoc {
    constructor(data) {
        Object.assign(this, data);
        this._id = this._id || crypto.randomUUID();
        this.createdAt = this.createdAt || new Date();
    }

    async save() {
        inMemoryTransfers.set(this.transferId, this);
        return this;
    }
}

class InMemoryFileDoc {
    constructor(data) {
        Object.assign(this, data);
        this._id = this._id || crypto.randomUUID();
        this.createdAt = this.createdAt || new Date();
        this.downloaded = this.downloaded || false;
        this.downloadedAt = this.downloadedAt || null;
    }

    async save() {
        inMemoryFiles.set(this._id.toString(), this);
        return this;
    }
}

function matchQuery(doc, query) {
    for (const [key, val] of Object.entries(query)) {
        if (key === "$or" && Array.isArray(val)) {
            const orMatch = val.some(subQ => matchQuery(doc, subQ));
            if (!orMatch) return false;
            continue;
        }
        if (val && typeof val === "object" && val.$lt) {
            if (!(doc[key] < val.$lt)) return false;
            continue;
        }
        const docVal = doc[key] ? doc[key].toString() : doc[key];
        const queryVal = val ? val.toString() : val;
        if (docVal !== queryVal) return false;
    }
    return true;
}

const TransferStore = {
    async create(data) {
        if (mongoose.connection.readyState === 1) {
            const TransferModel = mongoose.model("Transfer");
            return await TransferModel.create(data);
        }
        const doc = new InMemoryTransferDoc(data);
        inMemoryTransfers.set(doc.transferId, doc);
        return doc;
    },

    async findOne(query) {
        if (mongoose.connection.readyState === 1) {
            const TransferModel = mongoose.model("Transfer");
            return await TransferModel.findOne(query);
        }
        for (const doc of inMemoryTransfers.values()) {
            if (matchQuery(doc, query)) return doc;
        }
        return null;
    },

    async find(query = {}) {
        if (mongoose.connection.readyState === 1) {
            const TransferModel = mongoose.model("Transfer");
            return await TransferModel.find(query);
        }
        const matches = [];
        for (const doc of inMemoryTransfers.values()) {
            if (matchQuery(doc, query)) matches.push(doc);
        }
        return matches;
    },

    async deleteOne(query) {
        if (mongoose.connection.readyState === 1) {
            const TransferModel = mongoose.model("Transfer");
            return await TransferModel.deleteOne(query);
        }
        for (const [key, doc] of inMemoryTransfers.entries()) {
            if (matchQuery(doc, query)) {
                inMemoryTransfers.delete(key);
                return { deletedCount: 1 };
            }
        }
        return { deletedCount: 0 };
    }
};

const FileStore = {
    async create(data) {
        if (mongoose.connection.readyState === 1) {
            const FileModel = mongoose.model("File");
            return await FileModel.create(data);
        }
        const doc = new InMemoryFileDoc(data);
        inMemoryFiles.set(doc._id.toString(), doc);
        return doc;
    },

    async findOne(query) {
        if (mongoose.connection.readyState === 1) {
            const FileModel = mongoose.model("File");
            return await FileModel.findOne(query);
        }
        for (const doc of inMemoryFiles.values()) {
            if (matchQuery(doc, query)) return doc;
        }
        return null;
    },

    find(query = {}) {
        if (mongoose.connection.readyState === 1) {
            const FileModel = mongoose.model("File");
            return FileModel.find(query);
        }
        const matches = [];
        for (const doc of inMemoryFiles.values()) {
            if (matchQuery(doc, query)) matches.push(doc);
        }
        return {
            select: () => Promise.resolve(matches),
            then: (resolve) => resolve(matches)
        };
    },

    async findOneAndUpdate(query, update, options = {}) {
        if (mongoose.connection.readyState === 1) {
            const FileModel = mongoose.model("File");
            return await FileModel.findOneAndUpdate(query, update, options);
        }
        for (const doc of inMemoryFiles.values()) {
            if (matchQuery(doc, query)) {
                if (update.$set) {
                    Object.assign(doc, update.$set);
                }
                return doc;
            }
        }
        return null;
    },

    async deleteMany(query) {
        if (mongoose.connection.readyState === 1) {
            const FileModel = mongoose.model("File");
            return await FileModel.deleteMany(query);
        }
        let count = 0;
        for (const [key, doc] of inMemoryFiles.entries()) {
            if (matchQuery(doc, query)) {
                inMemoryFiles.delete(key);
                count++;
            }
        }
        return { deletedCount: count };
    },

    async countDocuments(query) {
        if (mongoose.connection.readyState === 1) {
            const FileModel = mongoose.model("File");
            return await FileModel.countDocuments(query);
        }
        let count = 0;
        for (const doc of inMemoryFiles.values()) {
            if (matchQuery(doc, query)) count++;
        }
        return count;
    }
};

module.exports = {
    TransferStore,
    FileStore,
    inMemoryTransfers,
    inMemoryFiles
};
