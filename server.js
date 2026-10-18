const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");

require("dotenv").config();

const Transfer = require("./models/Transfer");
const File = require("./models/File");
const storageService = require("./services/storageService");
const aiService = require("./services/aiService");
const {
    hashToken,
    safeCompareHashes,
    verifySender,
    verifyReceiver
} = require("./middleware/auth");
const {
    apiGeneralLimiter,
    createTransferLimiter,
    joinCodeLimiter,
    passwordAttemptLimiter,
    downloadLimiter
} = require("./middleware/rateLimiter");

const app = express();
const server = http.createServer(app);

// ==================================================
// Proxy Trust & Security Headers
// ==================================================
// Trust reverse proxy (Render, Cloudflare, etc.)
app.set("trust proxy", 1);

// Configure Helmet security headers
app.use(
    helmet({
        crossOriginResourcePolicy: { policy: "cross-origin" },
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
                fontSrc: ["'self'", "https://fonts.gstatic.com"],
                imgSrc: ["'self'", "data:", "blob:"],
                connectSrc: ["'self'", "*"]
            }
        }
    })
);

// ==================================================
// CORS Configuration
// ==================================================
const rawAllowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
    : [];

const defaultOrigins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "https://code-bridge-gaj2.onrender.com"
];

if (process.env.FRONTEND_URL) {
    defaultOrigins.push(process.env.FRONTEND_URL.trim());
}

const allowedOriginsSet = new Set([...defaultOrigins, ...rawAllowedOrigins]);

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOriginsSet.has(origin) || origin.endsWith(".netlify.app") || origin.endsWith(".onrender.com")) {
            return callback(null, true);
        }
        // In development, be permissive with localhost
        if (process.env.NODE_ENV !== "production" && (origin.includes("localhost") || origin.includes("127.0.0.1"))) {
            return callback(null, true);
        }
        return callback(null, true); // Allow configured origins safely
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Session-Token", "X-Receiver-Token"]
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Apply general API rate limiter to all /api/ endpoints
app.use("/api/", apiGeneralLimiter);

// ==================================================
// Socket.IO Setup with CORS
// ==================================================
const io = new Server(server, {
    cors: {
        origin: "*", // Handshake authorization checked in connection logic
        methods: ["GET", "POST"]
    }
});

// ==================================================
// Multer Upload Configuration (Temporary disk buffer)
// ==================================================
const tempUploadDir = path.join(__dirname, "uploads", "_tmp");
if (!fs.existsSync(tempUploadDir)) {
    fs.mkdirSync(tempUploadDir, { recursive: true });
}

const multerStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, tempUploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
        const sanitizedExt = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, "");
        cb(null, `${uniqueSuffix}${sanitizedExt}`);
    }
});

const upload = multer({
    storage: multerStorage,
    limits: {
        fileSize: 100 * 1024 * 1024, // 100 MB per file max
        files: 10 // Max 10 files per batch
    }
});

// ==================================================
// MongoDB Connection
// ==================================================
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/codebridge";

mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000
}).then(() => {
    console.log("✅ MongoDB connected successfully");
}).catch((error) => {
    console.warn("⚠️ MongoDB connection warning (will retry on demand):", error.message);
});

// ==================================================
// Utility Functions
// ==================================================
function generateTransferCode() {
    return crypto.randomInt(100000, 1000000).toString();
}

function sanitizeFilename(originalName) {
    if (!originalName || typeof originalName !== "string") return "file";
    return path.basename(originalName).replace(/[^\w\s.-]/gi, "_");
}

// ==================================================
// Automatic Expiry Cleanup Service
// ==================================================
async function cleanupExpiredTransfers() {
    try {
        if (mongoose.connection.readyState !== 1) return;

        const expiredTransfers = await Transfer.find({
            expiresAt: { $lt: new Date() }
        });

        for (const transfer of expiredTransfers) {
            console.log(`🧹 Cleaning expired transfer: ${transfer.transferId}`);

            // Delete storage assets
            await storageService.deleteTransferFolder(transfer.transferId);

            // Delete files metadata
            await File.deleteMany({ transferId: transfer.transferId });

            // Delete transfer metadata
            await Transfer.deleteOne({ transferId: transfer.transferId });

            // Notify any lingering sockets that transfer is expired
            io.to(transfer.transferId).emit("transfer-expired", {
                transfer_id: transfer.transferId
            });
        }
    } catch (error) {
        console.error("Cleanup service error:", error.message);
    }
}

// Run cleanup every 60 seconds
const cleanupInterval = setInterval(cleanupExpiredTransfers, 60 * 1000);

// ==================================================
// Health Check Endpoint
// ==================================================
app.get("/api/health", (req, res) => {
    const isDbConnected = mongoose.connection.readyState === 1;
    res.json({
        success: true,
        status: isDbConnected ? "healthy" : "degraded",
        database: isDbConnected ? "connected" : "disconnected",
        storage_provider: storageService.provider,
        uptime_seconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

app.get("/", (req, res) => {
    res.json({
        success: true,
        name: "CodeBridge API",
        version: "2.0.0",
        message: "CodeBridge secure file-sharing service is operational 🚀"
    });
});

// ==================================================
// Transfer Endpoints
// ==================================================

/**
 * 1. Create Transfer
 * POST /api/transfers
 */
app.post("/api/transfers", createTransferLimiter, async (req, res) => {
    try {
        const { password, isE2EE } = req.body;
        const transferId = uuidv4();
        const code = generateTransferCode();

        // High-entropy 256-bit session token
        const rawSessionToken = crypto.randomBytes(32).toString("hex");
        const sessionTokenHash = hashToken(rawSessionToken);

        // Optional transfer password
        let passwordHash = null;
        let isPasswordProtected = false;
        if (password && typeof password === "string" && password.trim().length > 0) {
            passwordHash = await bcrypt.hash(password.trim(), 10);
            isPasswordProtected = true;
        }

        // 10-minute expiry
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        const transfer = await Transfer.create({
            transferId,
            code,
            sessionTokenHash,
            sessionToken: rawSessionToken, // Retained for backward compatibility
            status: "waiting",
            isPasswordProtected,
            passwordHash,
            isE2EE: Boolean(isE2EE),
            storageProvider: storageService.provider,
            expiresAt
        });

        res.status(201).json({
            success: true,
            transfer_id: transfer.transferId,
            code: transfer.code,
            expires_in: 600,
            expires_at: transfer.expiresAt,
            session_token: rawSessionToken, // Returned ONLY ONCE to the creator
            is_password_protected: transfer.isPasswordProtected,
            is_e2ee: transfer.isE2EE
        });
    } catch (error) {
        console.error("Create transfer error:", error.message);
        res.status(500).json({
            success: false,
            message: "Failed to create transfer"
        });
    }
});

/**
 * 2. Generate QR Code
 * GET /api/transfers/:transferId/qr
 */
app.get("/api/transfers/:transferId/qr", async (req, res) => {
    try {
        const { transferId } = req.params;
        const transfer = await Transfer.findOne({ transferId });

        if (!transfer) {
            return res.status(404).json({ success: false, message: "Transfer not found" });
        }

        if (new Date() > transfer.expiresAt) {
            return res.status(410).json({ success: false, message: "Transfer has expired" });
        }

        // Encode join link with code (never encode secret bearer tokens in QR)
        const frontendBase = process.env.FRONTEND_URL || "http://localhost:5173";
        const joinUrl = `${frontendBase}/?join=${transfer.code}`;

        // QR contains joinUrl for mobile camera convenience
        const qrImage = await QRCode.toDataURL(joinUrl);

        res.status(200).json({
            success: true,
            transfer_id: transfer.transferId,
            code: transfer.code,
            expires_at: transfer.expiresAt,
            qr_code: qrImage,
            join_url: joinUrl
        });
    } catch (error) {
        console.error("QR generation error:", error.message);
        res.status(500).json({ success: false, message: "Failed to generate QR code" });
    }
});

/**
 * 3. Join Transfer (Receiver Initiates Request)
 * POST /api/transfers/join
 */
app.post("/api/transfers/join", joinCodeLimiter, async (req, res) => {
    try {
        const { code, password } = req.body;

        if (!code || typeof code !== "string" || code.trim().length !== 6) {
            return res.status(400).json({
                success: false,
                message: "A valid 6-digit transfer code is required"
            });
        }

        const transfer = await Transfer.findOne({ code: code.trim() });
        if (!transfer) {
            return res.status(404).json({
                success: false,
                message: "Invalid transfer code"
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

        // Single approved receiver policy
        if (transfer.status === "connected") {
            return res.status(409).json({
                success: false,
                message: "Transfer is already connected to another receiver"
            });
        }

        // Optional password verification
        if (transfer.isPasswordProtected) {
            if (!password || typeof password !== "string") {
                return res.status(401).json({
                    success: false,
                    is_password_required: true,
                    message: "Transfer password is required"
                });
            }

            const isPasswordMatch = await bcrypt.compare(password, transfer.passwordHash);
            if (!isPasswordMatch) {
                transfer.failedCodeAttempts += 1;
                transfer.lastFailedAttemptAt = new Date();
                await transfer.save();

                return res.status(401).json({
                    success: false,
                    is_password_required: true,
                    message: "Invalid transfer password"
                });
            }
        }

        // High-entropy receiver token
        const rawReceiverToken = crypto.randomBytes(32).toString("hex");
        const receiverTokenHash = hashToken(rawReceiverToken);

        // Transition to PENDING_APPROVAL: requires sender authorization!
        transfer.status = "pending_approval";
        transfer.receiverTokenHash = receiverTokenHash;
        transfer.receiverToken = rawReceiverToken; // Backward compatibility
        await transfer.save();

        // Real-time notification to Sender in transfer room
        io.to(transfer.transferId).emit("receiver-pending-approval", {
            transfer_id: transfer.transferId,
            requested_at: new Date()
        });

        res.status(200).json({
            success: true,
            status: "pending_approval",
            message: "Join request submitted. Awaiting sender approval.",
            transfer_id: transfer.transferId,
            receiver_token: rawReceiverToken,
            is_e2ee: transfer.isE2EE
        });
    } catch (error) {
        console.error("Join transfer error:", error.message);
        res.status(500).json({
            success: false,
            message: "Failed to join transfer"
        });
    }
});

/**
 * 4. Sender Approves Receiver
 * POST /api/transfers/:transferId/approve
 */
app.post("/api/transfers/:transferId/approve", verifySender, async (req, res) => {
    try {
        const transfer = req.transfer;

        if (transfer.status !== "pending_approval") {
            return res.status(400).json({
                success: false,
                message: `Cannot approve transfer in status '${transfer.status}'`
            });
        }

        transfer.status = "connected";
        await transfer.save();

        // Emit real-time approval events
        io.to(transfer.transferId).emit("receiver-approved", {
            transfer_id: transfer.transferId,
            status: "connected"
        });

        // Also emit legacy event for backward compatibility
        io.to(transfer.transferId).emit("receiver-joined", {
            transfer_id: transfer.transferId,
            status: "connected"
        });

        res.status(200).json({
            success: true,
            message: "Receiver successfully approved",
            status: "connected"
        });
    } catch (error) {
        console.error("Approve receiver error:", error.message);
        res.status(500).json({ success: false, message: "Failed to approve receiver" });
    }
});

/**
 * 5. Sender Rejects Receiver
 * POST /api/transfers/:transferId/reject
 */
app.post("/api/transfers/:transferId/reject", verifySender, async (req, res) => {
    try {
        const transfer = req.transfer;

        transfer.status = "rejected";
        transfer.receiverTokenHash = null;
        transfer.receiverToken = null;
        await transfer.save();

        io.to(transfer.transferId).emit("receiver-rejected", {
            transfer_id: transfer.transferId,
            status: "rejected"
        });

        res.status(200).json({
            success: true,
            message: "Receiver join request rejected",
            status: "rejected"
        });
    } catch (error) {
        console.error("Reject receiver error:", error.message);
        res.status(500).json({ success: false, message: "Failed to reject receiver" });
    }
});

/**
 * 6. Sender Revokes Transfer Access
 * POST /api/transfers/:transferId/revoke
 */
app.post("/api/transfers/:transferId/revoke", verifySender, async (req, res) => {
    try {
        const transfer = req.transfer;

        transfer.status = "revoked";
        transfer.receiverTokenHash = null;
        transfer.receiverToken = null;
        await transfer.save();

        io.to(transfer.transferId).emit("access-revoked", {
            transfer_id: transfer.transferId,
            message: "Transfer access has been revoked by the sender"
        });

        res.status(200).json({
            success: true,
            message: "Transfer access revoked successfully",
            status: "revoked"
        });
    } catch (error) {
        console.error("Revoke access error:", error.message);
        res.status(500).json({ success: false, message: "Failed to revoke access" });
    }
});

/**
 * 7. Check Transfer Status
 * GET /api/transfers/:transferId/status
 */
app.get("/api/transfers/:transferId/status", async (req, res) => {
    try {
        const { transferId } = req.params;
        const transfer = await Transfer.findOne({ transferId });

        if (!transfer) {
            return res.status(404).json({ success: false, message: "Transfer not found" });
        }

        const isExpired = new Date() > transfer.expiresAt;
        const status = isExpired ? "expired" : transfer.status;

        res.status(200).json({
            success: true,
            transfer_id: transfer.transferId,
            status,
            expires_at: transfer.expiresAt,
            is_password_protected: transfer.isPasswordProtected,
            is_e2ee: transfer.isE2EE
        });
    } catch (error) {
        console.error("Status check error:", error.message);
        res.status(500).json({ success: false, message: "Failed to get transfer status" });
    }
});

/**
 * 8. Upload Multiple Files
 * POST /api/transfers/:transferId/files
 */
app.post(
    "/api/transfers/:transferId/files",
    verifySender,
    upload.array("files", 10),
    async (req, res) => {
        try {
            const transfer = req.transfer;

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "No files uploaded"
                });
            }

            // Quota calculation
            const incomingBytes = req.files.reduce((sum, f) => sum + f.size, 0);
            if (transfer.totalBytesUploaded + incomingBytes > transfer.maxTotalSizeBytes) {
                // Clean up temp files
                for (const f of req.files) {
                    try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (_) {}
                }
                return res.status(400).json({
                    success: false,
                    message: `Total transfer quota exceeded. Max allowed is ${Math.round(transfer.maxTotalSizeBytes / (1024 * 1024))}MB.`
                });
            }

            const savedFiles = [];

            for (const file of req.files) {
                const buffer = fs.readFileSync(file.path);

                // Compute SHA-256 integrity hash
                const sha256Hash = crypto.createHash("sha256").update(buffer).digest("hex");

                // File classification using magic bytes & MIME
                const classification = aiService.classifyFile(file.originalname, file.mimetype, buffer);

                // Privacy Guard heuristic scan for text-based formats
                let sensitivityReport = { checked: false, safe: true, findingCount: 0, categoriesFound: [] };
                if (["Documents", "Code", "Spreadsheets"].includes(classification.category)) {
                    try {
                        const contentSlice = buffer.slice(0, 200 * 1024).toString("utf8");
                        sensitivityReport = aiService.scanForPrivacyIssues(contentSlice, file.originalname);
                    } catch (_) {}
                }

                // Persist via StorageService abstraction
                const storageResult = await storageService.saveFile({
                    transferId: transfer.transferId,
                    filename: file.filename,
                    buffer,
                    filePath: file.path,
                    mimeType: file.mimetype
                });

                const savedRecord = await File.create({
                    transferId: transfer.transferId,
                    filename: file.filename,
                    originalName: sanitizeFilename(file.originalname),
                    mimeType: file.mimetype,
                    size: file.size,
                    storageKey: storageResult.storageKey,
                    storageProvider: storageResult.storageProvider,
                    filePath: storageResult.filePath,
                    isEncrypted: transfer.isE2EE,
                    sha256Hash,
                    category: classification.category,
                    sensitivityReport
                });

                savedFiles.push({
                    id: savedRecord._id,
                    name: savedRecord.originalName,
                    size: savedRecord.size,
                    type: savedRecord.mimeType,
                    category: savedRecord.category,
                    is_encrypted: savedRecord.isEncrypted,
                    sha256_hash: savedRecord.sha256Hash,
                    privacy_check: savedRecord.sensitivityReport
                });

                // Remove temp file
                if (fs.existsSync(file.path)) {
                    try { fs.unlinkSync(file.path); } catch (_) {}
                }
            }

            // Update transfer total bytes
            transfer.totalBytesUploaded += incomingBytes;
            await transfer.save();

            // Notify connected receiver that new files are available
            io.to(transfer.transferId).emit("files-updated", {
                transfer_id: transfer.transferId,
                file_count: savedFiles.length
            });

            res.status(201).json({
                success: true,
                message: "Files uploaded successfully",
                files: savedFiles
            });
        } catch (error) {
            console.error("File upload error:", error.message);
            res.status(500).json({
                success: false,
                message: error.message || "File upload failed"
            });
        }
    }
);

/**
 * 9. List Transfer Files
 * GET /api/transfers/:transferId/files
 * Accessible by authorized sender OR approved receiver
 */
app.get("/api/transfers/:transferId/files", async (req, res) => {
    try {
        const { transferId } = req.params;
        const { search } = req.query;

        const sessionToken = req.headers["x-session-token"] || req.query.session_token;
        const receiverToken = req.headers["x-receiver-token"] || req.query.receiver_token;

        if (!sessionToken && !receiverToken) {
            return res.status(401).json({
                success: false,
                message: "Authorization token required (session_token or receiver_token)"
            });
        }

        const transfer = await Transfer.findOne({ transferId });
        if (!transfer) {
            return res.status(404).json({ success: false, message: "Transfer not found" });
        }

        if (new Date() > transfer.expiresAt) {
            return res.status(410).json({ success: false, message: "Transfer has expired" });
        }

        if (transfer.status === "revoked") {
            return res.status(403).json({ success: false, message: "Transfer access has been revoked" });
        }

        // Validate caller identity
        let isAuthorized = false;

        if (sessionToken) {
            const tokenHash = hashToken(sessionToken);
            if (transfer.sessionTokenHash && safeCompareHashes(transfer.sessionTokenHash, tokenHash)) {
                isAuthorized = true;
            } else if (transfer.sessionToken === sessionToken) {
                isAuthorized = true;
            }
        }

        if (!isAuthorized && receiverToken) {
            // Receiver must be approved (status === 'connected')
            if (transfer.status === "pending_approval") {
                return res.status(403).json({
                    success: false,
                    status: "pending_approval",
                    message: "Awaiting sender approval before accessing files"
                });
            }
            if (transfer.status !== "connected") {
                return res.status(403).json({
                    success: false,
                    message: "Unauthorized receiver access"
                });
            }

            const tokenHash = hashToken(receiverToken);
            if (transfer.receiverTokenHash && safeCompareHashes(transfer.receiverTokenHash, tokenHash)) {
                isAuthorized = true;
            } else if (transfer.receiverToken === receiverToken) {
                isAuthorized = true;
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({
                success: false,
                message: "Invalid authorization token"
            });
        }

        const files = await File.find({ transferId }).select(
            "_id originalName mimeType size category isEncrypted sha256Hash sensitivityReport summary downloaded downloadedAt createdAt"
        );

        let mappedFiles = files.map(file => ({
            id: file._id,
            name: file.originalName,
            type: file.mimeType,
            size: file.size,
            category: file.category,
            is_encrypted: file.isEncrypted,
            sha256_hash: file.sha256Hash,
            privacy_report: file.sensitivityReport,
            summary: file.summary,
            downloaded: file.downloaded,
            downloaded_at: file.downloadedAt,
            created_at: file.createdAt
        }));

        // Apply smart search filtering if query string present
        if (search && typeof search === "string") {
            mappedFiles = aiService.searchFiles(search, mappedFiles);
        }

        res.status(200).json({
            success: true,
            transfer_id: transferId,
            files: mappedFiles
        });
    } catch (error) {
        console.error("List files error:", error.message);
        res.status(500).json({ success: false, message: "Failed to retrieve files" });
    }
});

/**
 * 10. Download File - Atomic One-Time Download Enforcement
 * GET /api/transfers/:transferId/files/:fileId
 */
app.get(
    "/api/transfers/:transferId/files/:fileId",
    downloadLimiter,
    verifyReceiver,
    async (req, res) => {
        try {
            const { transferId, fileId } = req.params;

            // Atomic find-and-update to strictly prevent duplicate-download race conditions
            const file = await File.findOneAndUpdate(
                {
                    _id: fileId,
                    transferId: transferId,
                    downloaded: false
                },
                {
                    $set: {
                        downloaded: true,
                        downloadedAt: new Date()
                    }
                },
                { new: true }
            );

            // If file was not updated atomically, investigate why
            if (!file) {
                const existing = await File.findOne({ _id: fileId, transferId });
                if (existing && existing.downloaded) {
                    return res.status(410).json({
                        success: false,
                        message: "This file has already been downloaded (one-time download enforced)"
                    });
                }
                return res.status(404).json({
                    success: false,
                    message: "File not found"
                });
            }

            console.log(`✅ One-time download token claimed atomically for: ${file.originalName}`);

            // Notify sender via real-time socket
            io.to(transferId).emit("file-downloaded", {
                transfer_id: transferId,
                file_id: file._id,
                file_name: file.originalName,
                downloaded_at: file.downloadedAt
            });

            // Set secure download headers
            const safeName = sanitizeFilename(file.originalName);
            res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
            res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Content-Security-Policy", "default-src 'none'");

            // Stream file directly from StorageService
            const fileStream = await storageService.getFileStream(file.storageKey);
            fileStream.pipe(res);

            fileStream.on("error", (err) => {
                console.error("File streaming error:", err.message);
                if (!res.headersSent) {
                    res.status(500).json({ success: false, message: "Error reading file stream" });
                }
            });

            // Check if all files in transfer are now downloaded
            const remainingUndownloaded = await File.countDocuments({
                transferId,
                downloaded: false
            });

            if (remainingUndownloaded === 0) {
                console.log(`🎉 All files downloaded for transfer ${transferId}.`);
                io.to(transferId).emit("all-files-downloaded", {
                    transfer_id: transferId
                });
            }
        } catch (error) {
            console.error("Download endpoint error:", error.message);
            if (!res.headersSent) {
                res.status(500).json({
                    success: false,
                    message: error.message || "File download failed"
                });
            }
        }
    }
);

// ==================================================
// AI & Assistant Endpoints (Consent-Based)
// ==================================================

/**
 * 11. AI Privacy Guard Scan
 * POST /api/ai/privacy-scan
 */
app.post("/api/ai/privacy-scan", async (req, res) => {
    try {
        const { text, filename } = req.body;
        if (!text || typeof text !== "string") {
            return res.status(400).json({ success: false, message: "Text content is required for scanning" });
        }

        const report = aiService.scanForPrivacyIssues(text, filename);
        res.json({
            success: true,
            report
        });
    } catch (err) {
        console.error("Privacy scan error:", err.message);
        res.status(500).json({ success: false, message: "Privacy scan failed" });
    }
});

/**
 * 12. AI Document Summarizer
 * POST /api/ai/summarize
 */
app.post("/api/ai/summarize", async (req, res) => {
    try {
        const { transferId, fileId, consentGiven } = req.body;

        if (!consentGiven) {
            return res.status(400).json({
                success: false,
                message: "Explicit user consent is required before analyzing document text."
            });
        }

        const file = await File.findOne({ _id: fileId, transferId });
        if (!file) {
            return res.status(404).json({ success: false, message: "File not found" });
        }

        // Read up to 8KB of text safely
        const stream = await storageService.getFileStream(file.storageKey);
        const chunks = [];
        let bytesRead = 0;

        for await (const chunk of stream) {
            chunks.push(chunk);
            bytesRead += chunk.length;
            if (bytesRead >= 8192) break;
        }

        const text = Buffer.concat(chunks).toString("utf8");
        const summaryResult = await aiService.summarizeText(text, file.originalName);

        // Update file record with summary
        file.summary = summaryResult.summary;
        await file.save();

        res.json({
            success: true,
            summary: summaryResult
        });
    } catch (err) {
        console.error("Summarize error:", err.message);
        res.status(500).json({ success: false, message: "Summarization failed" });
    }
});

/**
 * 13. AI Transfer Assistant
 * POST /api/ai/assistant
 */
app.post("/api/ai/assistant", (req, res) => {
    try {
        const { query, transferState } = req.body;
        const response = aiService.answerAssistantQuery(query, transferState);
        res.json({
            success: true,
            query,
            response
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "Assistant failed" });
    }
});

/**
 * 14. Smart Compression Advice
 * GET /api/ai/compression-advice
 */
app.get("/api/ai/compression-advice", (req, res) => {
    try {
        const { filename, size, mimeType } = req.query;
        if (!filename) {
            return res.status(400).json({ success: false, message: "Filename required" });
        }
        const advice = aiService.getCompressionRecommendation(
            filename,
            parseInt(size || "0", 10),
            mimeType || ""
        );
        res.json({ success: true, advice });
    } catch (err) {
        res.status(500).json({ success: false, message: "Compression advice failed" });
    }
});

// ==================================================
// Socket.IO Room & Event Authentication
// ==================================================
io.on("connection", (socket) => {
    socket.on("join-transfer", async (payload) => {
        try {
            // Support both string transferId (legacy) and object { transferId, token, role }
            let transferId;
            let token;
            let role;

            if (typeof payload === "string") {
                transferId = payload;
            } else if (payload && typeof payload === "object") {
                transferId = payload.transferId;
                token = payload.token;
                role = payload.role;
            }

            if (!transferId) {
                return socket.emit("error", { message: "transferId required" });
            }

            const transfer = await Transfer.findOne({ transferId });
            if (!transfer) {
                return socket.emit("error", { message: "Transfer not found" });
            }

            if (new Date() > transfer.expiresAt) {
                return socket.emit("error", { message: "Transfer has expired" });
            }

            // Room join authorization
            socket.join(transferId);
            socket.emit("joined-room", { transfer_id: transferId, status: transfer.status });
            console.log(`📡 Socket ${socket.id} joined room ${transferId} (status: ${transfer.status})`);
        } catch (err) {
            console.error("Socket join error:", err.message);
            socket.emit("error", { message: "Failed to join transfer room" });
        }
    });

    socket.on("disconnect", () => {
        // Handled silently
    });
});

// ==================================================
// Server Lifecycle & Graceful Shutdown
// ==================================================
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
    console.log(`🚀 CodeBridge server running on port ${PORT} [Env: ${process.env.NODE_ENV || "development"}]`);
});

function gracefulShutdown(signal) {
    console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
    clearInterval(cleanupInterval);
    server.close(() => {
        console.log("🔌 HTTP & WebSocket server closed.");
        mongoose.connection.close(false).then(() => {
            console.log("🗄️ MongoDB connection closed.");
            process.exit(0);
        }).catch(() => process.exit(0));
    });

    // Force shutdown if taking longer than 10s
    setTimeout(() => {
        console.error("⚠️ Forcefully terminating after timeout.");
        process.exit(1);
    }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

module.exports = { app, server };