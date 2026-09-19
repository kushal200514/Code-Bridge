import axios from "axios";
import { io } from "socket.io-client";
import "./App.css";
import { useState, useEffect } from "react";

function App() {

    // ==============================
    // Sender State
    // ==============================

    const [transfer, setTransfer] = useState(null);
    const [qrCode, setQrCode] = useState(null);

    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState(false);

    const [selectedFiles, setSelectedFiles] = useState([]);
    const [uploadedFiles, setUploadedFiles] = useState([]);
    const [timeLeft, setTimeLeft] = useState(0);
    useEffect(() => {
    if (!transfer?.expires_at) return;

    const updateCountdown = () => {
        const expiryTime = new Date(
            transfer.expires_at
        ).getTime();

        const remaining = Math.max(
            0,
            Math.floor(
                (expiryTime - Date.now()) / 1000
            )
        );

        setTimeLeft(remaining);
    };

    updateCountdown();

    const interval = setInterval(
        updateCountdown,
        1000
    );

    return () => clearInterval(interval);
}, [transfer]);

    // ==============================
    // Receiver State
    // ==============================

    const [receiverMode, setReceiverMode] = useState(false);
    const [receiverCode, setReceiverCode] = useState("");
    const [receiverTransfer, setReceiverTransfer] = useState(null);
    const [receiverFiles, setReceiverFiles] = useState([]);

    // ==============================
    // Connection State
    // ==============================

    const [receiverConnected, setReceiverConnected] = useState(false);

    // ==============================
    // General State
    // ==============================

    const [error, setError] = useState("");


    // ==================================================
    // Socket.IO Connection
    // ==================================================

    const connectToTransferSocket = (transferId) => {

        const socket = io("http://localhost:5000");

        socket.on("connect", () => {

            console.log("🔌 Connected to CodeBridge socket");

            socket.emit("join-transfer", transferId);

            console.log(
                "📡 Joined transfer room:",
                transferId
            );

        });

        socket.on("receiver-joined", (data) => {

            console.log(
                "🟢 Receiver joined:",
                data
            );

            setReceiverConnected(true);

        });

        socket.on("disconnect", () => {

            console.log(
                "🔌 Socket disconnected"
            );

        });

        return socket;
    };

    // ==================================================
// Receiver Socket.IO Connection
// ==================================================

const connectReceiverSocket = (
    transferId,
    receiverToken
) => {

    const socket = io(
        "http://localhost:5000"
    );

    socket.on("connect", () => {

        console.log(
            "🔌 Receiver connected to CodeBridge socket"
        );

        socket.emit(
            "join-transfer",
            transferId
        );

        console.log(
            "📡 Receiver joined transfer room:",
            transferId
        );

    });


    socket.on(
        "files-updated",
        async (data) => {

            console.log(
                "📁 New files available:",
                data
            );

            try {

                const response =
                    await axios.get(
                        `http://localhost:5000/api/transfers/${transferId}/files`,
                        {
                            params: {
                                receiver_token:
                                    receiverToken
                            }
                        }
                    );

                setReceiverFiles(
                    response.data.files
                );

                console.log(
                    "✅ Receiver file list updated"
                );

            }

            catch (err) {

                console.error(
                    "❌ Could not refresh files:",
                    err
                );

            }

        }
    );


    socket.on("disconnect", () => {

        console.log(
            "🔌 Receiver socket disconnected"
        );

    });


    return socket;
};



    // ==================================================
    // Create Transfer
    // ==================================================

    const createTransfer = async () => {

        try {

            setLoading(true);
            setError("");
            setReceiverConnected(false);

            const response = await axios.post(
                "http://localhost:5000/api/transfers"
            );

            const transferData = response.data;

            setTransfer(transferData);

            // Connect sender to Socket.IO room
            connectToTransferSocket(
                transferData.transfer_id
            );

            // Get QR code
            const qrResponse = await axios.get(
                `http://localhost:5000/api/transfers/${transferData.transfer_id}/qr`
            );

            setQrCode(
                qrResponse.data.qr_code
            );

        }

        catch (err) {

            console.error(err);

            setError(
                err.response?.data?.message ||
                "Could not create transfer."
            );

        }

        finally {

            setLoading(false);

        }

    };


    // ==================================================
    // Select Files
    // ==================================================

    const handleFileSelect = (event) => {

        const files =
            Array.from(event.target.files);

        setSelectedFiles(files);

        setError("");

    };


    // ==================================================
    // Upload Files
    // ==================================================

    const uploadFiles = async () => {

        if (!transfer) {
            return;
        }

        if (selectedFiles.length === 0) {

            setError(
                "Please select at least one file."
            );

            return;
        }

        try {

            setUploading(true);
            setError("");

            const formData = new FormData();

            selectedFiles.forEach((file) => {

                formData.append(
                    "files",
                    file
                );

            });

            formData.append(
                "session_token",
                transfer.session_token
            );

            const response = await axios.post(
                `http://localhost:5000/api/transfers/${transfer.transfer_id}/files`,
                formData
            );

            setUploadedFiles(
                response.data.files
            );

            setSelectedFiles([]);

        }

        catch (err) {

            console.error(err);

            setError(
                err.response?.data?.message ||
                "File upload failed."
            );

        }

        finally {

            setUploading(false);

        }

    };


    // ==================================================
    // Join Transfer
    // ==================================================

    const joinTransfer = async () => {

        if (receiverCode.length !== 6) {

            setError(
                "Please enter a valid 6-digit code."
            );

            return;
        }

        try {

            setLoading(true);
            setError("");

            // Join transfer
            const joinResponse =
                await axios.post(
                    "http://localhost:5000/api/transfers/join",
                    {
                        code: receiverCode
                    }
                );

            const joinedTransfer =
                joinResponse.data;

            // Get files
            const filesResponse =
                await axios.get(
                    `http://localhost:5000/api/transfers/${joinedTransfer.transfer_id}/files`,
                    {
                        params: {
                            receiver_token:
                                joinedTransfer.receiver_token
                        }
                    }
                );

            setReceiverTransfer({

                transfer_id:
                    joinedTransfer.transfer_id,

                receiver_token:
                    joinedTransfer.receiver_token

            });
            connectReceiverSocket(
    joinedTransfer.transfer_id,
    joinedTransfer.receiver_token
);

            setReceiverFiles(
                filesResponse.data.files
            );

        }

        catch (err) {

            console.error(err);

            setError(
                err.response?.data?.message ||
                "Could not join transfer."
            );

        }

        finally {

            setLoading(false);

        }

    };


    // ==================================================
    // Download File
    // ==================================================

    const downloadFile = (file) => {

        if (!receiverTransfer) {
            return;
        }

        const downloadUrl =
            `http://localhost:5000/api/transfers/${receiverTransfer.transfer_id}/files/${file.id}?receiver_token=${receiverTransfer.receiver_token}`;

        window.open(
            downloadUrl,
            "_blank"
        );

    };


    // ==================================================
    // Receiver Join Screen
    // ==================================================

    if (
        receiverMode &&
        !receiverTransfer
    ) {

        return (

            <div className="app">

                <div className="container">

                    <div className="logo">
                        🔗 CodeBridge
                    </div>

                    <h1>
                        Receive Files
                    </h1>

                    <p className="subtitle">
                        Enter the 6-digit code from
                        the sending device.
                    </p>

                    <div className="receiver-card">

                        <input
                            type="text"
                            maxLength="6"
                            inputMode="numeric"
                            value={receiverCode}
                            onChange={(event) => {

                                const value =
                                    event.target.value
                                        .replace(/\D/g, "");

                                setReceiverCode(
                                    value
                                );

                                setError("");

                            }}
                            placeholder="000000"
                        />

                        <button
                            className="primary"
                            onClick={joinTransfer}
                            disabled={
                                loading ||
                                receiverCode.length !== 6
                            }
                        >

                            {loading
                                ? "Joining..."
                                : "Join Transfer"}

                        </button>

                        {error && (

                            <p className="error">
                                {error}
                            </p>

                        )}

                        <button
                            className="secondary back-button"
                            onClick={() => {

                                setReceiverMode(false);
                                setReceiverCode("");
                                setError("");

                            }}
                        >
                            Back
                        </button>

                    </div>

                </div>

            </div>

        );

    }


    // ==================================================
    // Receiver Files Screen
    // ==================================================

    if (receiverTransfer) {

        return (

            <div className="app">

                <div className="container">

                    <div className="logo">
                        🔗 CodeBridge
                    </div>

                    <h1>
                        Files Ready
                    </h1>

                    <p className="subtitle">
                        Select a file to download.
                    </p>

                    <div className="file-list">

                        {receiverFiles.length === 0 ? (

                            <div className="empty-state">

                                <p>
                                    No files have been uploaded yet.
                                </p>

                            </div>

                        ) : (

                            receiverFiles.map(
                                (file) => (

                                    <div
                                        className="file-item"
                                        key={file.id}
                                    >

                                        <span>
                                            📄 {file.name}
                                        </span>

                                        <button
                                            className="download-button"
                                            onClick={() =>
                                                downloadFile(file)
                                            }
                                        >
                                            Download
                                        </button>

                                    </div>

                                )
                            )

                        )}

                    </div>

                    <button
                        className="secondary back-button"
                        onClick={() => {

                            setReceiverTransfer(null);
                            setReceiverFiles([]);
                            setReceiverCode("");
                            setReceiverMode(false);
                            setError("");

                        }}
                    >
                        Back to Home
                    </button>

                </div>

            </div>

        );

    }


    // ==================================================
    // Sender Transfer Screen
    // ==================================================

    if (transfer) {

        return (

            <div className="app">

                <div className="container">

                    <div className="logo">
                        🔗 CodeBridge
                    </div>

                    <h1>
                        Your transfer is ready.
                    </h1>

                    <p className="subtitle">
                        Share this code with the receiving device.
                    </p>


                    {/* Transfer Code */}

                    <div className="code-card">

                        <div className="code-label">
                            Transfer Code
                        </div>

                        <div className="transfer-code">
                            {transfer.code}
                        </div>

                      <div
    className={
        timeLeft > 0
            ? "expiry"
            : "expiry expired"
    }
>
    {timeLeft > 0 ? (
        <>
            ⏱ Expires in{" "}
            {Math.floor(timeLeft / 60)
                .toString()
                .padStart(2, "0")}
            :
            {(timeLeft % 60)
                .toString()
                .padStart(2, "0")}
        </>
    ) : (
        <>⛔ Transfer expired</>
    )}
</div>
                        {/* Receiver Connection Status */}

                        <div
                            className={
                                receiverConnected
                                    ? "connection-status connected"
                                    : "connection-status waiting"
                            }
                        >
                            {receiverConnected
                                ? "🟢 Receiver connected"
                                : "🟡 Waiting for receiver..."}
                        </div>

                    </div>


                    {/* QR Code */}

                    {qrCode && (

                        <div className="qr-section">

                            <h3>
                                Scan to Join
                            </h3>

                            <div className="qr-card">

                                <img
                                    src={qrCode}
                                    alt="Transfer QR Code"
                                />

                            </div>

                            <p>
                                Scan this QR code from
                                the receiving device.
                            </p>

                        </div>

                    )}


                    {/* File Picker */}

                    <div className="upload-section">

                        <label
                            htmlFor="file-input"
                            className="file-picker"
                        >
                            📁 Select Files
                        </label>

                        <input
                            id="file-input"
                            type="file"
                            multiple
                            onChange={handleFileSelect}
                        />

                    </div>


                    {/* Selected Files */}

                    {selectedFiles.length > 0 && (

                        <div className="file-list">

                            <h3>
                                Selected Files
                            </h3>

                            {selectedFiles.map(
                                (file, index) => (

                                    <div
                                        className="file-item"
                                        key={`${file.name}-${index}`}
                                    >

                                        <span>
                                            📄 {file.name}
                                        </span>

                                        <span>
                                            {(
                                                file.size / 1024
                                            ).toFixed(1)} KB
                                        </span>

                                    </div>

                                )
                            )}

                        </div>

                    )}


                    {/* Upload Button */}

                    {selectedFiles.length > 0 && (

                        <button
                            className="primary upload-button"
                            onClick={uploadFiles}
                            disabled={uploading}
                        >

                            {uploading
                                ? "Uploading..."
                                : "Upload Files"}

                        </button>

                    )}


                    {/* Uploaded Files */}

                    {uploadedFiles.length > 0 && (

                        <div className="file-list uploaded">

                            <h3>
                                Uploaded Files
                            </h3>

                            {uploadedFiles.map(
                                (file) => (

                                    <div
                                        className="file-item"
                                        key={file.id}
                                    >

                                        <span>
                                            ✅ {file.name}
                                        </span>

                                        <span>
                                            {(
                                                file.size / 1024
                                            ).toFixed(1)} KB
                                        </span>

                                    </div>

                                )
                            )}

                        </div>

                    )}


                    {error && (

                        <p className="error">
                            {error}
                        </p>

                    )}


                    <button
                        className="secondary back-button"
                        onClick={() => {

                            setTransfer(null);
                            setQrCode(null);
                            setSelectedFiles([]);
                            setUploadedFiles([]);
                            setReceiverConnected(false);
                            setError("");

                        }}
                    >
                        Create Another Transfer
                    </button>

                </div>

            </div>

        );

    }


    // ==================================================
    // Landing Screen
    // ==================================================

    return (

        <div className="app">

            <div className="container">

                <div className="logo">
                    🔗 CodeBridge
                </div>

                <h1>
                    Transfer files.
                    <br />
                    <span>
                        Without an account.
                    </span>
                </h1>

                <p className="subtitle">
                    Fast, temporary and private
                    file transfers between devices.
                </p>

                <div className="actions">

                    <button
                        className="primary"
                        onClick={createTransfer}
                        disabled={loading}
                    >

                        {loading
                            ? "Creating..."
                            : "Send Files"}

                    </button>

                    <button
                        className="secondary"
                        onClick={() => {

                            setReceiverMode(true);
                            setError("");

                        }}
                    >
                        Receive Files
                    </button>

                </div>

                {error && (

                    <p className="error">
                        {error}
                    </p>

                )}

                <div className="features">

                    <div>
                        🔐
                        <span>
                            Temporary
                        </span>
                    </div>

                    <div>
                        ⚡
                        <span>
                            Fast
                        </span>
                    </div>

                    <div>
                        🗑️
                        <span>
                            Auto-expire
                        </span>
                    </div>

                </div>

            </div>

        </div>

    );

}

export default App;