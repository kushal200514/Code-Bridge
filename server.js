const multer = require("multer");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const File = require("./models/File");

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");

require("dotenv").config();

const Transfer = require("./models/Transfer");

const app = express();


// ==================================================
// Middleware
// ==================================================

app.use(cors());

app.use(express.json());


// ==================================================
// Server
// ==================================================

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);


// ==================================================
// Socket.IO
// ==================================================

const io = new Server(server, {
    cors: {
        origin: "*"
    }
});


// ==================================================
// File Upload Configuration
// ==================================================

const storage = multer.diskStorage({

    destination: function (req, file, cb) {

        const transferId =
            req.params.transferId;

        const uploadPath =
            path.join(
                __dirname,
                "uploads",
                transferId
            );

        fs.mkdirSync(
            uploadPath,
            {
                recursive: true
            }
        );

        cb(
            null,
            uploadPath
        );
    },


    filename: function (req, file, cb) {

        const uniqueName =
            `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${path.extname(file.originalname)}`;

        cb(
            null,
            uniqueName
        );
    }

});


const upload = multer({

    storage: storage,

    limits: {
        fileSize:
            100 * 1024 * 1024
    }

});


// ==================================================
// MongoDB Connection
// ==================================================

mongoose
    .connect(process.env.MONGODB_URI)

    .then(() => {

        console.log(
            "✅ MongoDB connected"
        );

    })

    .catch((error) => {

        console.error(
            "❌ MongoDB connection failed:",
            error.message
        );

    });


// ==================================================
// Home
// ==================================================

app.get(
    "/",
    (req, res) => {

        res.json({

            success: true,

            message:
                "CodeBridge API is running 🚀"

        });

    }
);


// ==================================================
// Health Check
// ==================================================

app.get(
    "/api/health",
    (req, res) => {

        res.json({

            success: true,

            message:
                "Backend is healthy"

        });

    }
);


// ==================================================
// Generate Secure 6-Digit Transfer Code
// ==================================================

function generateTransferCode() {

    return crypto
        .randomInt(
            100000,
            1000000
        )
        .toString();

}


// ==================================================
// Cleanup Expired Transfers
// ==================================================

async function cleanupExpiredTransfers() {

    try {

        const expiredTransfers =
            await Transfer.find({

                expiresAt: {
                    $lt: new Date()
                }

            });


        for (
            const transfer
            of expiredTransfers
        ) {

            console.log(
                `🧹 Cleaning transfer: ${transfer.transferId}`
            );


            // Find files belonging to transfer

            const files =
                await File.find({

                    transferId:
                        transfer.transferId

                });


            // Delete physical files

            for (
                const file
                of files
            ) {

                if (
                    fs.existsSync(
                        file.filePath
                    )
                ) {

                    fs.unlinkSync(
                        file.filePath
                    );

                    console.log(
                        `🗑️ Deleted file: ${file.originalName}`
                    );

                }

            }


            // Delete file metadata

            await File.deleteMany({

                transferId:
                    transfer.transferId

            });


            // Delete transfer metadata

            await Transfer.deleteOne({

                transferId:
                    transfer.transferId

            });


            console.log(
                `✅ Transfer cleaned: ${transfer.transferId}`
            );

        }

    }

    catch (error) {

        console.error(
            "❌ Cleanup error:",
            error
        );

    }

}


// ==================================================
// Create Transfer
// ==================================================

app.post(
    "/api/transfers",

    async (req, res) => {

        try {

            const transferId =
                uuidv4();


            const code =
                generateTransferCode();


            const sessionToken =
                crypto
                    .randomBytes(32)
                    .toString("hex");


            // Transfer expires after 10 minutes

            const expiresAt =
                new Date(
                    Date.now() +
                    10 * 60 * 1000
                );


            const transfer =
                await Transfer.create({

                    transferId,

                    code,

                    sessionToken,

                    status:
                        "waiting",

                    expiresAt

                });


            res.status(201).json({

                success: true,

                transfer_id:
                    transfer.transferId,

                code:
                    transfer.code,

                expires_in:
                    600,

                expires_at:
                    transfer.expiresAt,

                session_token:
                    transfer.sessionToken

            });

        }

        catch (error) {

            console.error(
                "Create transfer error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "Failed to create transfer"

            });

        }

    }

);


// ==================================================
// Join Transfer
// ==================================================

app.post(
    "/api/transfers/join",

    async (req, res) => {

        try {

            const { code } =
                req.body;


            // Check code

            if (!code) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Transfer code is required"

                });

            }


            // Find transfer

            const transfer =
                await Transfer.findOne({

                    code:
                        code

                });


            if (!transfer) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Invalid transfer code"

                });

            }


            // Check expiry

            if (
                new Date() >
                transfer.expiresAt
            ) {

                transfer.status =
                    "expired";

                await transfer.save();


                return res.status(410).json({

                    success: false,

                    message:
                        "Transfer has expired"

                });

            }


            // Check transfer status

            if (
                transfer.status !==
                "waiting"
            ) {

                return res.status(409).json({

                    success: false,

                    message:
                        "Transfer is no longer available"

                });

            }


            // Generate receiver token

            const receiverToken =
                crypto
                    .randomBytes(32)
                    .toString("hex");


            // Update transfer

            transfer.status =
                "connected";

            transfer.receiverToken =
                receiverToken;


            await transfer.save();


            // Notify sender

            io.to(
                transfer.transferId
            ).emit(
                "receiver-joined",
                {
                    transfer_id:
                        transfer.transferId,

                    status:
                        "connected"
                }
            );


            res.status(200).json({

                success: true,

                message:
                    "Successfully joined transfer",

                transfer_id:
                    transfer.transferId,

                receiver_token:
                    receiverToken

            });

        }

        catch (error) {

            console.error(
                "Join transfer error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "Failed to join transfer"

            });

        }

    }

);


// ==================================================
// Upload Multiple Files
// ==================================================

app.post(

    "/api/transfers/:transferId/files",

    upload.array(
        "files",
        10
    ),

    async (req, res) => {

        try {

            const {
                transferId
            } = req.params;


            const {
                session_token
            } = req.body;


            // Check sender token

            if (!session_token) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Session token required"

                });

            }


            // Find transfer

            const transfer =
                await Transfer.findOne({

                    transferId:
                        transferId

                });


            if (!transfer) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Transfer not found"

                });

            }


            // Verify sender token

            if (
                transfer.sessionToken !==
                session_token
            ) {

                return res.status(403).json({

                    success: false,

                    message:
                        "Invalid session token"

                });

            }


            // Check expiry

            if (
                new Date() >
                transfer.expiresAt
            ) {

                transfer.status =
                    "expired";

                await transfer.save();


                return res.status(410).json({

                    success: false,

                    message:
                        "Transfer has expired"

                });

            }


            // Check files

            if (
                !req.files ||
                req.files.length === 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "No files uploaded"

                });

            }


            // Save metadata

            const savedFiles = [];


            for (
                const uploadedFile
                of req.files
            ) {

                const file =
                    await File.create({

                        transferId:
                            transferId,

                        filename:
                            uploadedFile.filename,

                        originalName:
                            uploadedFile.originalname,

                        mimeType:
                            uploadedFile.mimetype,

                        size:
                            uploadedFile.size,

                        filePath:
                            uploadedFile.path

                    });


                savedFiles.push({

                    id:
                        file._id,

                    name:
                        file.originalName,

                    size:
                        file.size,

                    type:
                        file.mimeType

                });

            }


            // ==========================================
            // Notify receiver about new files
            // ==========================================

            io.to(
                transferId
            ).emit(
                "files-updated",
                {
                    transfer_id:
                        transferId
                }
            );


            // Send upload response

            res.status(201).json({

                success: true,

                message:
                    "Files uploaded successfully",

                files:
                    savedFiles

            });

        }

        catch (error) {

            console.error(
                "File upload error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "File upload failed"

            });

        }

    }

);


// ==================================================
// List Transfer Files
// ==================================================

app.get(

    "/api/transfers/:transferId/files",

    async (req, res) => {

        try {

            const {
                transferId
            } = req.params;


            const {
                receiver_token
            } = req.query;


            // Check receiver token

            if (!receiver_token) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Receiver token required"

                });

            }


            // Find transfer

            const transfer =
                await Transfer.findOne({

                    transferId:
                        transferId

                });


            if (!transfer) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Transfer not found"

                });

            }


            // Verify receiver token

            if (
                transfer.receiverToken !==
                receiver_token
            ) {

                return res.status(403).json({

                    success: false,

                    message:
                        "Invalid receiver token"

                });

            }


            // Check expiry

            if (
                new Date() >
                transfer.expiresAt
            ) {

                transfer.status =
                    "expired";

                await transfer.save();


                return res.status(410).json({

                    success: false,

                    message:
                        "Transfer has expired"

                });

            }


            // Get files

            const files =
                await File.find({

                    transferId:
                        transferId

                }).select(
                    "_id originalName mimeType size createdAt downloaded downloadedAt"
                );


            res.status(200).json({

                success: true,

                transfer_id:
                    transferId,

                files:
                    files.map(
                        file => ({

                            id:
                                file._id,

                            name:
                                file.originalName,

                            type:
                                file.mimeType,

                            size:
                                file.size,

                            created_at:
                                file.createdAt,

                            downloaded:
                                file.downloaded,

                            downloaded_at:
                                file.downloadedAt

                        })
                    )

            });

        }

        catch (error) {

            console.error(
                "List files error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "Failed to retrieve files"

            });

        }

    }

);


// ==================================================
// Download File - One Time
// ==================================================

app.get(

    "/api/transfers/:transferId/files/:fileId",

    async (req, res) => {

        try {

            const {
                transferId,
                fileId
            } = req.params;


            const {
                receiver_token
            } = req.query;


            // Check receiver token

            if (!receiver_token) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Receiver token required"

                });

            }


            // Find transfer

            const transfer =
                await Transfer.findOne({

                    transferId:
                        transferId

                });


            if (!transfer) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Transfer not found"

                });

            }


            // Verify receiver token

            if (
                transfer.receiverToken !==
                receiver_token
            ) {

                return res.status(403).json({

                    success: false,

                    message:
                        "Invalid receiver token"

                });

            }


            // Check expiry

            if (
                new Date() >
                transfer.expiresAt
            ) {

                transfer.status =
                    "expired";

                await transfer.save();


                return res.status(410).json({

                    success: false,

                    message:
                        "Transfer has expired"

                });

            }


            // Find file

            const file =
                await File.findOne({

                    _id:
                        fileId,

                    transferId:
                        transferId

                });


            // Check file exists

            if (!file) {

                return res.status(404).json({

                    success: false,

                    message:
                        "File not found"

                });

            }


            // Check if already downloaded

            if (file.downloaded) {

                return res.status(410).json({

                    success: false,

                    message:
                        "File has already been downloaded"

                });

            }


            // Check physical file

            if (
                !fs.existsSync(
                    file.filePath
                )
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Physical file not found"

                });

            }


            // Mark file as downloaded

            file.downloaded =
                true;

            file.downloadedAt =
                new Date();


            await file.save();


            console.log(
                `✅ File marked as downloaded: ${file.originalName}`
            );


            // Send file

            res.download(

                file.filePath,

                file.originalName,

                (error) => {

                    if (error) {

                        console.error(
                            "File download error:",
                            error.message
                        );

                    }

                }

            );

        }

        catch (error) {

            console.error(
                "Download endpoint error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "File download failed"

            });

        }

    }

);


// ==================================================
// Automatic Cleanup Every Minute
// ==================================================

setInterval(

    () => {

        cleanupExpiredTransfers();

    },

    60 * 1000

);


// ==================================================
// Generate Transfer QR Code
// ==================================================

app.get(
    "/api/transfers/:transferId/qr",

    async (req, res) => {

        try {

            const {
                transferId
            } = req.params;


            const transfer =
                await Transfer.findOne({

                    transferId:
                        transferId

                });


            if (!transfer) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Transfer not found"

                });

            }


            // Check expiry

            if (
                new Date() >
                transfer.expiresAt
            ) {

                return res.status(410).json({

                    success: false,

                    message:
                        "Transfer has expired"

                });

            }


            // QR contains the 6-digit transfer code

            const qrData =
                transfer.code;


            const qrImage =
                await QRCode.toDataURL(
                    qrData
                );


            res.status(200).json({

                success: true,

                transfer_id:
                    transfer.transferId,

                code:
                    transfer.code,

                expires_at:
                    transfer.expiresAt,

                qr_code:
                    qrImage

            });

        }

        catch (error) {

            console.error(
                "QR generation error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "Failed to generate QR code"

            });

        }

    }

);


// ==================================================
// Socket.IO
// ==================================================

io.on(
    "connection",
    (socket) => {

        console.log(
            `🔌 Client connected: ${socket.id}`
        );


        socket.on(
            "join-transfer",
            (transferId) => {

                socket.join(
                    transferId
                );

                console.log(
                    `📡 Socket ${socket.id} joined transfer ${transferId}`
                );

            }
        );


        socket.on(
            "disconnect",
            () => {

                console.log(
                    `🔌 Client disconnected: ${socket.id}`
                );

            }
        );

    }
);


// ==================================================
// Start Server
// ==================================================

server.listen(
    PORT,

    () => {

        console.log(
            `🚀 CodeBridge server running on http://localhost:${PORT}`
        );

    }
);