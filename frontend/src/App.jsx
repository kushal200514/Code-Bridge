import { useState, useEffect, useRef } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import "./App.css";
import {
    generateE2EEKey,
    encryptFile,
    decryptFileBlob,
    scanTextLocally
} from "./cryptoHelper";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

function App() {
    // ==================================================
    // Navigation & Global UI States
    // ==================================================
    const [receiverMode, setReceiverMode] = useState(() => {
        if (typeof window === "undefined") return false;
        const joinParam = new URLSearchParams(window.location.search).get("join");
        return Boolean(joinParam && /^\d{6}$/.test(joinParam));
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [copyFeedback, setCopyFeedback] = useState("");
    const [showSecurityModal, setShowSecurityModal] = useState(false);
    const [showAssistant, setShowAssistant] = useState(false);
    const [assistantQuery, setAssistantQuery] = useState("");
    const [assistantResponse, setAssistantResponse] = useState(null);

    // ==================================================
    // Sender States & Configuration
    // ==================================================
    const [enablePassword, setEnablePassword] = useState(false);
    const [transferPassword, setTransferPassword] = useState("");
    const [showSenderPassword, setShowSenderPassword] = useState(false);
    const [enableE2EE, setEnableE2EE] = useState(false);
    const [e2eKey, setE2eKey] = useState(null);

    const [transfer, setTransfer] = useState(null);
    const [qrCode, setQrCode] = useState(null);
    const [joinUrl, setJoinUrl] = useState("");
    const [timeLeft, setTimeLeft] = useState(0);

    const [selectedFiles, setSelectedFiles] = useState([]);
    const [uploadedFiles, setUploadedFiles] = useState([]);
    const [uploading, setUploading] = useState(false);

    // Sender Approval States
    const [pendingJoinRequest, setPendingJoinRequest] = useState(false);
    const [receiverConnected, setReceiverConnected] = useState(false);
    const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);

    // Privacy Guard States
    const [privacyReports, setPrivacyReports] = useState({});
    const [activeFindingModal, setActiveFindingModal] = useState(null);

    // ==================================================
    // Receiver States
    // ==================================================
    const [receiverCode, setReceiverCode] = useState(() => {
        if (typeof window === "undefined") return "";
        const joinParam = new URLSearchParams(window.location.search).get("join");
        return joinParam && /^\d{6}$/.test(joinParam) ? joinParam : "";
    });
    const [receiverPassword, setReceiverPassword] = useState("");
    const [showReceiverPassword, setShowReceiverPassword] = useState(false);
    const [needsPasswordInput, setNeedsPasswordInput] = useState(false);
    const [receiverTransfer, setReceiverTransfer] = useState(null);
    const [receiverStatus, setReceiverStatus] = useState("idle"); // idle, pending_approval, connected, rejected, revoked, expired
    const [receiverFiles, setReceiverFiles] = useState([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [selectedCategory, setSelectedCategory] = useState("All");
    const [downloadingId, setDownloadingId] = useState(null);
    const [downloadedIds, setDownloadedIds] = useState(new Set());
    const [activeSummary, setActiveSummary] = useState(null);
    const [consentModalFile, setConsentModalFile] = useState(null);

    const socketRef = useRef(null);

    // ==================================================
    // URL Hash Detection for E2EE key (#key=XXXXXX)
    // ==================================================
    useEffect(() => {
        if (window.location.hash.startsWith("#key=")) {
            const keyFragment = window.location.hash.replace("#key=", "");
            sessionStorage.setItem("cb_e2e_key", keyFragment);
        }
    }, []);

    // ==================================================
    // Countdown Timer Effect
    // ==================================================
    useEffect(() => {
        const expirySource = transfer?.expires_at || receiverTransfer?.expires_at;
        if (!expirySource) return;

        const updateCountdown = () => {
            const expiryTime = new Date(expirySource).getTime();
            const remaining = Math.max(0, Math.floor((expiryTime - Date.now()) / 1000));
            setTimeLeft(remaining);

            if (remaining === 0) {
                if (transfer) setTransfer(prev => ({ ...prev, expired: true }));
                if (receiverTransfer) setReceiverStatus("expired");
            }
        };

        updateCountdown();
        const interval = setInterval(updateCountdown, 1000);
        return () => clearInterval(interval);
    }, [transfer, receiverTransfer]);

    // ==================================================
    // Socket.IO Connection & Event Handlers
    // ==================================================
    const initSocket = (transferId, role, token) => {
        if (socketRef.current) {
            socketRef.current.disconnect();
        }

        const socket = io(API_URL, {
            transports: ["websocket", "polling"]
        });

        socket.on("connect", () => {
            console.log(`🔌 Socket connected (${role}):`, socket.id);
            socket.emit("join-transfer", {
                transferId,
                role,
                token
            });
        });

        // Event: Receiver submitted join code -> Sender notified of pending approval
        socket.on("receiver-pending-approval", () => {
            console.log("🔔 Receiver is requesting to join. Awaiting your approval!");
            setPendingJoinRequest(true);
        });

        // Event: Sender approved receiver -> Receiver can access files
        socket.on("receiver-approved", () => {
            console.log("✅ Receiver approved by sender!");
            setReceiverStatus("connected");
            setReceiverConnected(true);
            setPendingJoinRequest(false);
            if (role === "receiver") {
                fetchReceiverFiles(transferId, token);
            }
        });

        // Event: Sender rejected receiver
        socket.on("receiver-rejected", () => {
            console.log("❌ Join request rejected by sender");
            setReceiverStatus("rejected");
            setPendingJoinRequest(false);
        });

        // Event: Sender revoked access
        socket.on("access-revoked", () => {
            console.log("⛔ Access has been revoked");
            setReceiverStatus("revoked");
            setReceiverConnected(false);
        });

        // Event: Sender uploaded new files
        socket.on("files-updated", () => {
            console.log("📁 Files updated");
            if (role === "receiver") {
                fetchReceiverFiles(transferId, token);
            }
        });

        // Event: Receiver downloaded a file
        socket.on("file-downloaded", (data) => {
            console.log("📥 File downloaded:", data.file_name);
            setDownloadedIds(prev => new Set([...prev, data.file_id]));
        });

        // Event: Transfer expired
        socket.on("transfer-expired", () => {
            setTimeLeft(0);
            setReceiverStatus("expired");
        });

        socketRef.current = socket;
        return socket;
    };

    // Clean up socket on unmount
    useEffect(() => {
        return () => {
            if (socketRef.current) socketRef.current.disconnect();
        };
    }, []);

    // ==================================================
    // 1. Create Transfer (Sender)
    // ==================================================
    const handleCreateTransfer = async () => {
        try {
            setLoading(true);
            setError("");
            setPendingJoinRequest(false);
            setReceiverConnected(false);

            let generatedE2E = null;
            if (enableE2EE) {
                generatedE2E = await generateE2EEKey();
                setE2eKey(generatedE2E);
            }

            const payload = {
                isE2EE: enableE2EE,
                password: enablePassword ? transferPassword.trim() : null
            };

            const response = await axios.post(`${API_URL}/api/transfers`, payload);
            const data = response.data;
            setTransfer(data);

            // Fetch QR Code
            const qrRes = await axios.get(`${API_URL}/api/transfers/${data.transfer_id}/qr`);
            setQrCode(qrRes.data.qr_code);

            // Construct Join URL with #key if E2EE
            let shareableUrl = qrRes.data.join_url;
            if (generatedE2E) {
                shareableUrl += `#key=${generatedE2E.keyString}`;
            }
            setJoinUrl(shareableUrl);

            // Connect socket as sender
            initSocket(data.transfer_id, "sender", data.session_token);
        } catch (err) {
            console.error("Create transfer failed:", err);
            setError(err.response?.data?.message || "Failed to create transfer.");
        } finally {
            setLoading(false);
        }
    };

    // ==================================================
    // 2. Sender Approve / Reject / Revoke
    // ==================================================
    const handleApproveReceiver = async () => {
        if (!transfer) return;
        try {
            await axios.post(
                `${API_URL}/api/transfers/${transfer.transfer_id}/approve`,
                {},
                { headers: { Authorization: `Bearer ${transfer.session_token}` } }
            );
            setPendingJoinRequest(false);
            setReceiverConnected(true);
        } catch (err) {
            setError(err.response?.data?.message || "Approval failed.");
        }
    };

    const handleRejectReceiver = async () => {
        if (!transfer) return;
        try {
            await axios.post(
                `${API_URL}/api/transfers/${transfer.transfer_id}/reject`,
                {},
                { headers: { Authorization: `Bearer ${transfer.session_token}` } }
            );
            setPendingJoinRequest(false);
        } catch (err) {
            setError(err.response?.data?.message || "Rejection failed.");
        }
    };

    const handleRevokeTransfer = async () => {
        if (!transfer) return;
        try {
            await axios.post(
                `${API_URL}/api/transfers/${transfer.transfer_id}/revoke`,
                {},
                { headers: { Authorization: `Bearer ${transfer.session_token}` } }
            );
            setShowRevokeConfirm(false);
            setReceiverConnected(false);
            setTransfer(prev => ({ ...prev, revoked: true }));
        } catch (err) {
            setError(err.response?.data?.message || "Revocation failed.");
        }
    };

    // ==================================================
    // 3. File Selection & Privacy Scanning (Sender)
    // ==================================================
    const handleFileSelect = async (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;

        setSelectedFiles(files);
        setError("");

        // Run local in-browser Privacy Guard scan on text/code files
        const newReports = {};
        for (const file of files) {
            const isTextLike = /\.(txt|csv|json|js|jsx|ts|tsx|py|md|env|yml|yaml|xml|html)$/i.test(file.name);
            if (isTextLike && file.size < 500 * 1024) {
                try {
                    const text = await file.text();
                    const report = scanTextLocally(text, file.name);
                    newReports[file.name] = report;
                } catch {}
            }
        }
        setPrivacyReports(newReports);
    };

    // Upload Files
    const handleUploadFiles = async () => {
        if (!transfer || selectedFiles.length === 0) return;

        try {
            setUploading(true);
            setError("");

            const formData = new FormData();
            formData.append("session_token", transfer.session_token);

            for (const file of selectedFiles) {
                if (transfer.is_e2ee && e2eKey) {
                    // Encrypt file client-side before sending to server!
                    const encryptedBlob = await encryptFile(file, e2eKey.keyObject);
                    formData.append("files", encryptedBlob, file.name);
                } else {
                    formData.append("files", file, file.name);
                }
            }

            const response = await axios.post(
                `${API_URL}/api/transfers/${transfer.transfer_id}/files`,
                formData,
                { headers: { Authorization: `Bearer ${transfer.session_token}` } }
            );

            setUploadedFiles(response.data.files);
            setSelectedFiles([]);
        } catch (err) {
            console.error("Upload error:", err);
            setError(err.response?.data?.message || "File upload failed.");
        } finally {
            setUploading(false);
        }
    };

    // ==================================================
    // 4. Join Transfer (Receiver)
    // ==================================================
    const handleJoinTransfer = async () => {
        if (receiverCode.length !== 6) {
            setError("Please enter a valid 6-digit code.");
            return;
        }

        try {
            setLoading(true);
            setError("");

            const payload = {
                code: receiverCode,
                password: needsPasswordInput ? receiverPassword.trim() : undefined
            };

            const response = await axios.post(`${API_URL}/api/transfers/join`, payload);
            const data = response.data;

            setReceiverTransfer({
                transfer_id: data.transfer_id,
                receiver_token: data.receiver_token,
                is_e2ee: data.is_e2ee
            });

            // Set status to pending approval: sender must approve!
            setReceiverStatus("pending_approval");
            setNeedsPasswordInput(false);

            // Connect receiver socket to receive approval event
            initSocket(data.transfer_id, "receiver", data.receiver_token);
        } catch (err) {
            if (err.response?.status === 401 && err.response?.data?.is_password_required) {
                setNeedsPasswordInput(true);
                setError("This transfer is password-protected. Please enter password.");
            } else {
                setError(err.response?.data?.message || "Could not join transfer.");
            }
        } finally {
            setLoading(false);
        }
    };

    // Fetch Files for Receiver
    const fetchReceiverFiles = async (transferId, token) => {
        try {
            const res = await axios.get(`${API_URL}/api/transfers/${transferId}/files`, {
                headers: { "X-Receiver-Token": token }
            });
            setReceiverFiles(res.data.files || []);
        } catch (err) {
            console.error("Failed to fetch receiver files:", err);
        }
    };

    // ==================================================
    // 5. Download File (One-Time Atomic & E2EE Decrypt)
    // ==================================================
    const handleDownloadFile = async (file) => {
        if (!receiverTransfer || downloadedIds.has(file.id)) return;

        try {
            setDownloadingId(file.id);
            setError("");

            const downloadUrl = `${API_URL}/api/transfers/${receiverTransfer.transfer_id}/files/${file.id}?receiver_token=${receiverTransfer.receiver_token}`;
            const response = await axios.get(downloadUrl, {
                responseType: "blob",
                headers: { "X-Receiver-Token": receiverTransfer.receiver_token }
            });

            let finalBlob = response.data;

            // If transfer is End-to-End Encrypted, decrypt in receiver browser!
            if (file.is_encrypted || receiverTransfer.is_e2ee) {
                let keyStr = sessionStorage.getItem("cb_e2e_key");
                if (!keyStr) {
                    keyStr = prompt("🔒 Enter End-to-End Decryption Key provided by sender:");
                }

                if (!keyStr) {
                    throw new Error("Decryption key required to download E2EE file.");
                }

                const decryptedBuffer = await decryptFileBlob(response.data, keyStr.trim());
                finalBlob = new Blob([decryptedBuffer], { type: file.type || "application/octet-stream" });
            }

            // Trigger browser save
            const blobUrl = window.URL.createObjectURL(finalBlob);
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(blobUrl);

            // Mark as downloaded locally
            setDownloadedIds(prev => new Set([...prev, file.id]));
        } catch (err) {
            console.error("Download failed:", err);
            setError(err.response?.data?.message || err.message || "File download failed.");
        } finally {
            setDownloadingId(null);
        }
    };

    // ==================================================
    // 6. AI Summarization (Consent-Based)
    // ==================================================
    const handleRequestSummary = async (file) => {
        setConsentModalFile(file);
    };

    const confirmSummarization = async () => {
        if (!consentModalFile || !receiverTransfer) return;

        try {
            setLoading(true);
            const res = await axios.post(`${API_URL}/api/ai/summarize`, {
                transferId: receiverTransfer.transfer_id,
                fileId: consentModalFile.id,
                consentGiven: true
            });
            setActiveSummary(res.data.summary);
            setConsentModalFile(null);
        } catch (err) {
            setError(err.response?.data?.message || "Summarization failed.");
        } finally {
            setLoading(false);
        }
    };

    // ==================================================
    // 7. AI Assistant Handler
    // ==================================================
    const handleAskAssistant = async (queryText) => {
        const q = queryText || assistantQuery;
        if (!q.trim()) return;

        try {
            const res = await axios.post(`${API_URL}/api/ai/assistant`, {
                query: q,
                transferState: {
                    hasTransfer: Boolean(transfer),
                    receiverConnected
                }
            });
            setAssistantResponse(res.data.response);
            setAssistantQuery("");
        } catch (err) {
            console.error(err);
        }
    };

    // Helper: copy to clipboard
    const copyToClipboard = (text, label) => {
        navigator.clipboard.writeText(text);
        setCopyFeedback(label);
        setTimeout(() => setCopyFeedback(""), 2000);
    };

    // Filter receiver files by category & search query
    const filteredFiles = receiverFiles.filter(file => {
        const matchesCategory = selectedCategory === "All" || file.category === selectedCategory;
        const matchesSearch = !searchQuery || file.name.toLowerCase().includes(searchQuery.toLowerCase());
        return matchesCategory && matchesSearch;
    });

    // ==================================================
    // RENDER SCREENS
    // ==================================================
    return (
        <div className="app-shell">
            {/* Top Navigation Bar */}
            <header className="nav-header">
                <div className="nav-container">
                    <div className="brand" onClick={() => {
                        setReceiverMode(false);
                        setTransfer(null);
                        setReceiverTransfer(null);
                        setError("");
                    }}>
                        <span className="brand-logo">🔗</span>
                        <span className="brand-name">CodeBridge</span>
                        <span className="brand-badge">SHIELD ACTIVE</span>
                    </div>

                    <div className="nav-actions">
                        <button className="nav-btn" onClick={() => setShowSecurityModal(true)}>
                            🛡️ Security Guarantees
                        </button>
                        <button className="nav-btn" onClick={() => setShowAssistant(!showAssistant)}>
                            🤖 AI Assistant
                        </button>
                    </div>
                </div>
            </header>

            <main className="main-content">
                {/* Global Error Banner */}
                {error && (
                    <div style={{
                        background: "rgba(239, 68, 68, 0.15)",
                        border: "1px solid rgba(239, 68, 68, 0.4)",
                        color: "#FCA5A5",
                        borderRadius: "10px",
                        padding: "12px 18px",
                        marginBottom: "20px",
                        fontSize: "14px",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center"
                    }}>
                        <span>⚠️ {error}</span>
                        <button onClick={() => setError("")} style={{ background: "transparent", color: "#FCA5A5", cursor: "pointer" }}>✕</button>
                    </div>
                )}

                {/* ==================================================
                    VIEW 1: LANDING SCREEN
                   ================================================== */}
                {!transfer && !receiverMode && (
                    <div>
                        <div className="hero">
                            <div className="hero-pill">
                                🔐 Zero Accounts • Zero Knowledge • 10-Minute Ephemeral
                            </div>
                            <h1 className="hero-title">
                                Transfer files securely. <br />
                                <span>Without leaving a trace.</span>
                            </h1>
                            <p className="hero-desc">
                                Sender-approved, end-to-end encrypted file sharing with single-use atomic downloads
                                and instant server wipe upon completion or expiry.
                            </p>
                        </div>

                        <div className="action-grid">
                            {/* Send Files Card */}
                            <div className="action-card">
                                <div className="action-icon">🚀</div>
                                <h3>Send Files</h3>
                                <p>
                                    Generate a temporary 6-digit code or QR code. Control access with real-time approval
                                    and optional client-side AES-256 encryption.
                                </p>

                                <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "20px" }}>
                                    <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", color: "var(--text-secondary)" }}>
                                        <input
                                            type="checkbox"
                                            checked={enableE2EE}
                                            onChange={(e) => setEnableE2EE(e.target.checked)}
                                        />
                                        🔒 Client-Side End-to-End Encryption (AES-GCM)
                                    </label>

                                    <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", color: "var(--text-secondary)" }}>
                                        <input
                                            type="checkbox"
                                            checked={enablePassword}
                                            onChange={(e) => setEnablePassword(e.target.checked)}
                                        />
                                        🔑 Protect with Transfer Password
                                    </label>

                                    {enablePassword && (
                                        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                                            <input
                                                type={showSenderPassword ? "text" : "password"}
                                                placeholder="Enter secure transfer password"
                                                value={transferPassword}
                                                onChange={(e) => setTransferPassword(e.target.value)}
                                                style={{
                                                    width: "100%",
                                                    background: "var(--bg-input)",
                                                    border: "1px solid var(--border-subtle)",
                                                    borderRadius: "8px",
                                                    padding: "8px 38px 8px 12px",
                                                    color: "#FFF",
                                                    fontSize: "13px"
                                                }}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowSenderPassword(!showSenderPassword)}
                                                title={showSenderPassword ? "Hide password" : "Show password"}
                                                aria-label={showSenderPassword ? "Hide password" : "Show password"}
                                                style={{
                                                    position: "absolute",
                                                    right: "8px",
                                                    background: "transparent",
                                                    border: "none",
                                                    color: "var(--text-muted)",
                                                    cursor: "pointer",
                                                    fontSize: "15px",
                                                    display: "flex",
                                                    alignItems: "center",
                                                    padding: "4px"
                                                }}
                                            >
                                                {showSenderPassword ? "🙈" : "👁️"}
                                            </button>
                                        </div>
                                    )}
                                </div>

                                <button
                                    className="btn-primary"
                                    onClick={handleCreateTransfer}
                                    disabled={loading || (enablePassword && !transferPassword.trim())}
                                >
                                    {loading ? "Initializing..." : "Create Transfer"}
                                </button>
                            </div>

                            {/* Receive Files Card */}
                            <div className="action-card">
                                <div className="action-icon">📥</div>
                                <h3>Receive Files</h3>
                                <p>
                                    Have a 6-digit transfer code? Enter it below or scan the sender's QR code.
                                    The sender must approve your connection before files are visible.
                                </p>

                                <div style={{ marginBottom: "24px" }}>
                                    <div style={{ fontSize: "13px", color: "var(--text-muted)", marginBottom: "8px" }}>
                                        Fast pairing via 6-digit code:
                                    </div>
                                    <div style={{ display: "flex", gap: "8px" }}>
                                        <input
                                            type="text"
                                            maxLength={6}
                                            placeholder="000000"
                                            value={receiverCode}
                                            onChange={(e) => setReceiverCode(e.target.value.replace(/\D/g, ""))}
                                            style={{
                                                flex: 1,
                                                background: "var(--bg-input)",
                                                border: "1px solid var(--border-subtle)",
                                                borderRadius: "8px",
                                                padding: "10px 14px",
                                                fontFamily: "var(--mono)",
                                                fontSize: "18px",
                                                letterSpacing: "4px",
                                                color: "var(--accent-cyan)",
                                                textAlign: "center"
                                            }}
                                        />
                                    </div>
                                </div>

                                <button
                                    className="btn-secondary"
                                    onClick={() => setReceiverMode(true)}
                                >
                                    Join Transfer
                                </button>
                            </div>
                        </div>

                        {/* Security Pillars */}
                        <div className="security-pillars">
                            <div className="pillar-item">
                                <div className="pillar-icon">⏱️</div>
                                <div className="pillar-title">10-Minute Ephemeral Lifecycle</div>
                                <div className="pillar-desc">Transfers expire automatically after 10 minutes. Everything is permanently purged.</div>
                            </div>
                            <div className="pillar-item">
                                <div className="pillar-icon">🛡️</div>
                                <div className="pillar-title">Sender-Enforced Authorization</div>
                                <div className="pillar-desc">Knowing the 6-digit code is not enough. The sender must approve the receiver in real time.</div>
                            </div>
                            <div className="pillar-item">
                                <div className="pillar-icon">⚡</div>
                                <div className="pillar-title">One-Time Atomic Download</div>
                                <div className="pillar-desc">Once a file is claimed, it cannot be downloaded again. Concurrency races are blocked server-side.</div>
                            </div>
                            <div className="pillar-item">
                                <div className="pillar-icon">🔒</div>
                                <div className="pillar-title">AES-256 Zero-Knowledge</div>
                                <div className="pillar-desc">In E2EE mode, files are encrypted in your browser. The server only sees unreadable ciphertext.</div>
                            </div>
                        </div>
                    </div>
                )}

                {/* ==================================================
                    VIEW 2: SENDER ACTIVE TRANSFER DASHBOARD
                   ================================================== */}
                {transfer && (
                    <div className="transfer-container">
                        <div className="transfer-card">
                            <div className="transfer-header">
                                <div>
                                    <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-primary)" }}>
                                        Active Transfer Session
                                    </h2>
                                    <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                                        Share the code or QR with your recipient.
                                    </p>
                                </div>

                                <div className="transfer-meta-badges">
                                    <span className={`tag-badge countdown ${timeLeft < 120 ? "expiring" : ""}`}>
                                        ⏱️ {Math.floor(timeLeft / 60).toString().padStart(2, "0")}:{(timeLeft % 60).toString().padStart(2, "0")}
                                    </span>
                                    {transfer.is_e2ee && <span className="tag-badge e2ee">🔒 E2EE Active</span>}
                                    {transfer.is_password_protected && <span className="tag-badge password">🔑 Password Protected</span>}
                                </div>
                            </div>

                            {/* SENDER APPROVAL ALERT (When receiver attempts to join) */}
                            {pendingJoinRequest && (
                                <div className="approval-alert-card">
                                    <div className="approval-alert-header">
                                        <span style={{ fontSize: "22px" }}>🔔</span>
                                        <h4>Incoming Receiver Connection Request</h4>
                                    </div>
                                    <p>
                                        A device has entered your 6-digit transfer code. Would you like to grant them access
                                        to view and download files?
                                    </p>
                                    <div className="approval-buttons">
                                        <button className="btn-success" onClick={handleApproveReceiver}>
                                            ✅ Approve Receiver
                                        </button>
                                        <button className="btn-danger" onClick={handleRejectReceiver}>
                                            ❌ Reject
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Receiver Connection Status Indicator */}
                            <div style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                fontSize: "13px",
                                marginBottom: "20px",
                                padding: "8px 14px",
                                borderRadius: "8px",
                                background: receiverConnected ? "var(--success-bg)" : "rgba(245, 158, 11, 0.1)",
                                color: receiverConnected ? "var(--success)" : "var(--warning)",
                                border: `1px solid ${receiverConnected ? "rgba(16, 185, 129, 0.3)" : "rgba(245, 158, 11, 0.3)"}`
                            }}>
                                <span>{receiverConnected ? "🟢 Receiver connected & approved" : "🟡 Waiting for receiver to enter code..."}</span>
                            </div>

                            {/* Transfer Code Display */}
                            <div className="code-box">
                                <div className="code-title">Temporary Transfer Code</div>
                                <div className="code-display">{transfer.code}</div>
                                <div className="code-actions">
                                    <button
                                        className="action-pill-btn"
                                        onClick={() => copyToClipboard(transfer.code, "Code copied!")}
                                    >
                                        📋 Copy Code
                                    </button>
                                    <button
                                        className="action-pill-btn"
                                        onClick={() => copyToClipboard(joinUrl, "Link copied!")}
                                    >
                                        🔗 Copy Shareable Link
                                    </button>
                                    {transfer.is_e2ee && e2eKey && (
                                        <button
                                            className="action-pill-btn"
                                            onClick={() => copyToClipboard(e2eKey.keyString, "Encryption key copied!")}
                                        >
                                            🔑 Copy Decryption Key
                                        </button>
                                    )}
                                </div>
                                {copyFeedback && (
                                    <div style={{ fontSize: "12px", color: "var(--accent-cyan)", marginTop: "8px" }}>
                                        ✓ {copyFeedback}
                                    </div>
                                )}
                            </div>

                            {/* QR Code Section */}
                            {qrCode && (
                                <div className="qr-container">
                                    <div className="qr-image-wrapper">
                                        <img src={qrCode} alt="Transfer QR Code" />
                                    </div>
                                    <div className="qr-info">
                                        <h4>Scan with Mobile Camera</h4>
                                        <p>
                                            Opening this QR on another phone or tablet instantly opens CodeBridge
                                            with your transfer code pre-filled.
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* Drag and Drop File Selector */}
                            <label className="dropzone" htmlFor="file-upload-input">
                                <div className="dropzone-icon">📁</div>
                                <div className="dropzone-text">Click or drag & drop files to select</div>
                                <div className="dropzone-sub">Max 10 files • Up to 100MB per file • 250MB transfer quota</div>
                                <input
                                    id="file-upload-input"
                                    type="file"
                                    multiple
                                    onChange={handleFileSelect}
                                    style={{ display: "none" }}
                                />
                            </label>

                            {/* Selected Files Preview & Privacy Reports */}
                            {selectedFiles.length > 0 && (
                                <div style={{ marginBottom: "20px" }}>
                                    <div className="file-list-header">
                                        <span style={{ fontSize: "14px", fontWeight: 600 }}>Selected Files ({selectedFiles.length})</span>
                                    </div>

                                    {selectedFiles.map((file, idx) => {
                                        const report = privacyReports[file.name];
                                        return (
                                            <div className="file-row" key={`${file.name}-${idx}`}>
                                                <div className="file-info-group">
                                                    <span className="file-icon">📄</span>
                                                    <div className="file-meta-col">
                                                        <span className="file-name">{file.name}</span>
                                                        <div className="file-subtext">
                                                            <span>{(file.size / 1024).toFixed(1)} KB</span>
                                                            {report && !report.safe && (
                                                                <span
                                                                    style={{ color: "var(--warning)", cursor: "pointer", textDecoration: "underline" }}
                                                                    onClick={() => setActiveFindingModal(report)}
                                                                >
                                                                    ⚠️ {report.count} sensitive items detected
                                                                </span>
                                                            )}
                                                            {report && report.safe && (
                                                                <span style={{ color: "var(--success)" }}>✓ Privacy Guard: Clean</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>

                                                <button
                                                    className="btn-danger"
                                                    style={{ padding: "4px 8px", fontSize: "12px" }}
                                                    onClick={() => setSelectedFiles(selectedFiles.filter((_, i) => i !== idx))}
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                        );
                                    })}

                                    <button
                                        className="btn-primary"
                                        style={{ marginTop: "12px" }}
                                        onClick={handleUploadFiles}
                                        disabled={uploading}
                                    >
                                        {uploading ? "Encrypting & Uploading..." : "Upload Files to Transfer"}
                                    </button>
                                </div>
                            )}

                            {/* Uploaded Files Section */}
                            {uploadedFiles.length > 0 && (
                                <div style={{ marginTop: "24px" }}>
                                    <div className="file-list-header">
                                        <span style={{ fontSize: "14px", fontWeight: 600 }}>Ready on Server ({uploadedFiles.length})</span>
                                    </div>

                                    {uploadedFiles.map(file => (
                                        <div className="file-row" key={file.id}>
                                            <div className="file-info-group">
                                                <span className="file-icon">✅</span>
                                                <div className="file-meta-col">
                                                    <span className="file-name">{file.name}</span>
                                                    <div className="file-subtext">
                                                        <span>{(file.size / 1024).toFixed(1)} KB</span>
                                                        <span className="tag-badge" style={{ background: "rgba(255,255,255,0.05)", fontSize: "11px" }}>{file.category}</span>
                                                        {file.is_encrypted && <span className="tag-badge e2ee" style={{ fontSize: "11px" }}>E2EE</span>}
                                                    </div>
                                                </div>
                                            </div>

                                            <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                                                {downloadedIds.has(file.id) ? "Downloaded ✓" : "Waiting for download"}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Transfer Control Actions */}
                            <div style={{ display: "flex", gap: "12px", marginTop: "32px", paddingTop: "20px", borderTop: "1px solid var(--border-subtle)" }}>
                                <button className="btn-danger" onClick={() => setShowRevokeConfirm(true)}>
                                    ⛔ Revoke Transfer Access
                                </button>
                                <button
                                    className="btn-secondary"
                                    onClick={() => {
                                        setTransfer(null);
                                        setSelectedFiles([]);
                                        setUploadedFiles([]);
                                    }}
                                >
                                    Done / Back to Home
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ==================================================
                    VIEW 3: RECEIVER JOIN & DOWNLOAD DASHBOARD
                   ================================================== */}
                {receiverMode && (
                    <div className="transfer-container">
                        <div className="transfer-card">
                            {/* Subview 3A: Enter 6-digit Code */}
                            {!receiverTransfer && (
                                <div>
                                    <h2 style={{ fontSize: "22px", fontWeight: 700, marginBottom: "8px" }}>Receive Files</h2>
                                    <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginBottom: "24px" }}>
                                        Enter the 6-digit code shown on the sender's screen.
                                    </p>

                                    <div style={{ marginBottom: "20px" }}>
                                        <input
                                            type="text"
                                            maxLength={6}
                                            placeholder="000000"
                                            value={receiverCode}
                                            onChange={(e) => setReceiverCode(e.target.value.replace(/\D/g, ""))}
                                            style={{
                                                width: "100%",
                                                background: "var(--bg-input)",
                                                border: "1px solid var(--border-subtle)",
                                                borderRadius: "12px",
                                                padding: "16px",
                                                fontFamily: "var(--mono)",
                                                fontSize: "32px",
                                                letterSpacing: "8px",
                                                color: "var(--accent-cyan)",
                                                textAlign: "center"
                                            }}
                                        />
                                    </div>

                                    {needsPasswordInput && (
                                        <div style={{ marginBottom: "20px" }}>
                                            <label style={{ fontSize: "13px", color: "var(--text-secondary)", display: "block", marginBottom: "6px" }}>
                                                Transfer Password Required:
                                            </label>
                                            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                                                <input
                                                    type={showReceiverPassword ? "text" : "password"}
                                                    placeholder="Enter password set by sender"
                                                    value={receiverPassword}
                                                    onChange={(e) => setReceiverPassword(e.target.value)}
                                                    style={{
                                                        width: "100%",
                                                        background: "var(--bg-input)",
                                                        border: "1px solid var(--border-subtle)",
                                                        borderRadius: "10px",
                                                        padding: "12px 42px 12px 14px",
                                                        color: "#FFF",
                                                        fontSize: "14px"
                                                    }}
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => setShowReceiverPassword(!showReceiverPassword)}
                                                    title={showReceiverPassword ? "Hide password" : "Show password"}
                                                    aria-label={showReceiverPassword ? "Hide password" : "Show password"}
                                                    style={{
                                                        position: "absolute",
                                                        right: "10px",
                                                        background: "transparent",
                                                        border: "none",
                                                        color: "var(--text-muted)",
                                                        cursor: "pointer",
                                                        fontSize: "16px",
                                                        display: "flex",
                                                        alignItems: "center",
                                                        padding: "4px"
                                                    }}
                                                >
                                                    {showReceiverPassword ? "🙈" : "👁️"}
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    <div style={{ display: "flex", gap: "12px" }}>
                                        <button
                                            className="btn-primary"
                                            onClick={handleJoinTransfer}
                                            disabled={loading || receiverCode.length !== 6}
                                        >
                                            {loading ? "Joining..." : "Request to Join"}
                                        </button>
                                        <button
                                            className="btn-secondary"
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
                            )}

                            {/* Subview 3B: Awaiting Sender Approval */}
                            {receiverTransfer && receiverStatus === "pending_approval" && (
                                <div className="waiting-approval-screen">
                                    <div className="pulse-spinner" />
                                    <h3 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px" }}>
                                        Awaiting Sender Approval...
                                    </h3>
                                    <p style={{ fontSize: "14px", color: "var(--text-secondary)", maxWidth: "440px", margin: "0 auto 24px" }}>
                                        Your join request has been sent to the sender's device. For your privacy and security,
                                        files remain locked until the sender explicitly grants access.
                                    </p>
                                    <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                                        Listening for real-time authorization...
                                    </div>
                                </div>
                            )}

                            {/* Subview 3C: Sender Rejected Request */}
                            {receiverTransfer && receiverStatus === "rejected" && (
                                <div style={{ textAlign: "center", padding: "32px 16px" }}>
                                    <div style={{ fontSize: "48px", marginBottom: "16px" }}>🚫</div>
                                    <h3 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px", color: "var(--danger)" }}>
                                        Access Denied by Sender
                                    </h3>
                                    <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginBottom: "24px" }}>
                                        The sender declined your join request. You cannot view or download files from this transfer.
                                    </p>
                                    <button className="btn-secondary" onClick={() => {
                                        setReceiverTransfer(null);
                                        setReceiverMode(false);
                                    }}>
                                        Return to Home
                                    </button>
                                </div>
                            )}

                            {/* Subview 3D: Access Revoked */}
                            {receiverTransfer && receiverStatus === "revoked" && (
                                <div style={{ textAlign: "center", padding: "32px 16px" }}>
                                    <div style={{ fontSize: "48px", marginBottom: "16px" }}>⛔</div>
                                    <h3 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px", color: "var(--danger)" }}>
                                        Transfer Access Revoked
                                    </h3>
                                    <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginBottom: "24px" }}>
                                        The sender has revoked access to this transfer session.
                                    </p>
                                    <button className="btn-secondary" onClick={() => {
                                        setReceiverTransfer(null);
                                        setReceiverMode(false);
                                    }}>
                                        Return to Home
                                    </button>
                                </div>
                            )}

                            {/* Subview 3E: Transfer Expired */}
                            {receiverTransfer && receiverStatus === "expired" && (
                                <div style={{ textAlign: "center", padding: "32px 16px" }}>
                                    <div style={{ fontSize: "48px", marginBottom: "16px" }}>⌛</div>
                                    <h3 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px", color: "var(--warning)" }}>
                                        Transfer Has Expired
                                    </h3>
                                    <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginBottom: "24px" }}>
                                        The 10-minute transfer window has elapsed and files have been permanently wiped from the server.
                                    </p>
                                    <button className="btn-secondary" onClick={() => {
                                        setReceiverTransfer(null);
                                        setReceiverMode(false);
                                    }}>
                                        Return to Home
                                    </button>
                                </div>
                            )}

                            {/* Subview 3F: Connected & Approved -> Files Ready */}
                            {receiverTransfer && receiverStatus === "connected" && (
                                <div>
                                    <div className="transfer-header">
                                        <div>
                                            <h2 style={{ fontSize: "20px", fontWeight: 700 }}>Files Available</h2>
                                            <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                                                Click Download to retrieve. Note: Files can only be downloaded once.
                                            </p>
                                        </div>

                                        <div className="transfer-meta-badges">
                                            <span className={`tag-badge countdown ${timeLeft < 120 ? "expiring" : ""}`}>
                                                ⏱️ {Math.floor(timeLeft / 60).toString().padStart(2, "0")}:{(timeLeft % 60).toString().padStart(2, "0")}
                                            </span>
                                            {receiverTransfer.is_e2ee && <span className="tag-badge e2ee">🔒 E2EE Decryption Active</span>}
                                        </div>
                                    </div>

                                    {/* Smart Search & Category Filter */}
                                    <div className="file-list-header">
                                        <input
                                            type="text"
                                            className="search-input"
                                            placeholder="🔍 Smart search files..."
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                        />
                                        <div className="category-pills">
                                            {["All", "Documents", "Images", "Code", "Archives", "Other"].map(cat => (
                                                <span
                                                    key={cat}
                                                    className={`cat-pill ${selectedCategory === cat ? "active" : ""}`}
                                                    onClick={() => setSelectedCategory(cat)}
                                                >
                                                    {cat}
                                                </span>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Files Listing */}
                                    <div style={{ marginTop: "16px" }}>
                                        {filteredFiles.length === 0 ? (
                                            <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)", fontSize: "14px" }}>
                                                No files currently available. Sender may still be uploading.
                                            </div>
                                        ) : (
                                            filteredFiles.map(file => {
                                                const isDownloaded = downloadedIds.has(file.id) || file.downloaded;
                                                const isText = file.category === "Documents" || file.category === "Code";

                                                return (
                                                    <div className="file-row" key={file.id}>
                                                        <div className="file-info-group">
                                                            <span className="file-icon">📄</span>
                                                            <div className="file-meta-col">
                                                                <span className="file-name">{file.name}</span>
                                                                <div className="file-subtext">
                                                                    <span>{(file.size / 1024).toFixed(1)} KB</span>
                                                                    <span className="tag-badge" style={{ background: "rgba(255,255,255,0.05)", fontSize: "11px" }}>{file.category}</span>
                                                                    {file.is_encrypted && <span className="tag-badge e2ee" style={{ fontSize: "11px" }}>Encrypted</span>}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        <div className="file-actions-group">
                                                            {isText && !isDownloaded && (
                                                                <button
                                                                    className="btn-secondary btn-small"
                                                                    onClick={() => handleRequestSummary(file)}
                                                                >
                                                                    ✨ Summarize
                                                                </button>
                                                            )}

                                                            <button
                                                                className={isDownloaded ? "btn-secondary btn-small" : "btn-primary btn-small"}
                                                                onClick={() => handleDownloadFile(file)}
                                                                disabled={isDownloaded || downloadingId === file.id}
                                                            >
                                                                {downloadingId === file.id
                                                                    ? "Downloading..."
                                                                    : isDownloaded
                                                                        ? "Downloaded ✓"
                                                                        : "Download"}
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>

                                    <button
                                        className="btn-secondary"
                                        style={{ marginTop: "24px" }}
                                        onClick={() => {
                                            setReceiverTransfer(null);
                                            setReceiverMode(false);
                                        }}
                                    >
                                        Leave Transfer
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* ==================================================
                    MODAL: PRIVACY GUARD FINDINGS
                   ================================================== */}
                {activeFindingModal && (
                    <div className="modal-overlay" onClick={() => setActiveFindingModal(null)}>
                        <div className="modal-content" onClick={e => e.stopPropagation()}>
                            <div className="modal-header">
                                <h3>🛡️ Privacy Guard Report: {activeFindingModal.filename}</h3>
                                <button className="close-btn" onClick={() => setActiveFindingModal(null)}>✕</button>
                            </div>
                            <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "16px" }}>
                                We detected credentials, keys, or personal identifiers in this file. Review the findings
                                before sharing. File contents are inspected locally in your browser.
                            </p>

                            <div style={{ marginBottom: "20px" }}>
                                {activeFindingModal.findings.map((f, i) => (
                                    <div key={i} className={`finding-item ${f.severity.toLowerCase()}`}>
                                        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
                                            <span>{f.type}</span>
                                            <span style={{ fontSize: "11px", color: f.severity === "Critical" ? "var(--danger)" : "var(--warning)" }}>
                                                {f.severity} (Line {f.line})
                                            </span>
                                        </div>
                                        <div style={{ fontFamily: "var(--mono)", fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
                                            Redacted snippet: <code>{f.sample}</code>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <button className="btn-primary" onClick={() => setActiveFindingModal(null)}>
                                I Understand, Keep File
                            </button>
                        </div>
                    </div>
                )}

                {/* ==================================================
                    MODAL: AI SUMMARIZATION CONSENT
                   ================================================== */}
                {consentModalFile && (
                    <div className="modal-overlay" onClick={() => setConsentModalFile(null)}>
                        <div className="modal-content" onClick={e => e.stopPropagation()}>
                            <div className="modal-header">
                                <h3>✨ AI Document Summarization Consent</h3>
                                <button className="close-btn" onClick={() => setConsentModalFile(null)}>✕</button>
                            </div>
                            <p style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: "20px" }}>
                                You requested an AI summary for <strong>{consentModalFile.name}</strong>.
                                In compliance with CodeBridge zero-leak privacy rules:
                            </p>
                            <ul style={{ fontSize: "13px", color: "var(--text-muted)", paddingLeft: "20px", marginBottom: "24px", lineHeight: 1.6 }}>
                                <li>Only the first 8KB of document text will be analyzed.</li>
                                <li>The text is never used to train external models.</li>
                                <li>Summaries are held ephemerally and wiped with the transfer.</li>
                            </ul>
                            <div style={{ display: "flex", gap: "12px" }}>
                                <button className="btn-primary" onClick={confirmSummarization}>
                                    I Consent, Generate Summary
                                </button>
                                <button className="btn-secondary" onClick={() => setConsentModalFile(null)}>
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ==================================================
                    MODAL: DOCUMENT SUMMARY VIEW
                   ================================================== */}
                {activeSummary && (
                    <div className="modal-overlay" onClick={() => setActiveSummary(null)}>
                        <div className="modal-content" onClick={e => e.stopPropagation()}>
                            <div className="modal-header">
                                <h3>📄 Document Summary: {activeSummary.filename}</h3>
                                <button className="close-btn" onClick={() => setActiveSummary(null)}>✕</button>
                            </div>
                            <div style={{ background: "var(--bg-input)", padding: "16px", borderRadius: "10px", fontSize: "14px", lineHeight: 1.6, marginBottom: "16px" }}>
                                {activeSummary.summary}
                            </div>
                            {activeSummary.keyPoints && activeSummary.keyPoints.length > 0 && (
                                <div style={{ marginBottom: "20px" }}>
                                    <h4 style={{ fontSize: "13px", color: "var(--accent-blue)", marginBottom: "8px" }}>Key Points</h4>
                                    <ul style={{ fontSize: "13px", color: "var(--text-secondary)", paddingLeft: "18px" }}>
                                        {activeSummary.keyPoints.map((pt, i) => (
                                            <li key={i} style={{ marginBottom: "4px" }}>{pt}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            <button className="btn-secondary" onClick={() => setActiveSummary(null)}>
                                Close
                            </button>
                        </div>
                    </div>
                )}

                {/* ==================================================
                    MODAL: REVOCATION CONFIRMATION
                   ================================================== */}
                {showRevokeConfirm && (
                    <div className="modal-overlay" onClick={() => setShowRevokeConfirm(false)}>
                        <div className="modal-content" onClick={e => e.stopPropagation()}>
                            <div className="modal-header">
                                <h3>⚠️ Revoke Transfer Access</h3>
                                <button className="close-btn" onClick={() => setShowRevokeConfirm(false)}>✕</button>
                            </div>
                            <p style={{ fontSize: "14px", color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: "24px" }}>
                                Revoking access will immediately disconnect the receiver, invalidate all download tokens,
                                and prevent any further file access. This action cannot be undone.
                            </p>
                            <div style={{ display: "flex", gap: "12px" }}>
                                <button className="btn-danger" onClick={handleRevokeTransfer}>
                                    Yes, Revoke Access Now
                                </button>
                                <button className="btn-secondary" onClick={() => setShowRevokeConfirm(false)}>
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ==================================================
                    MODAL: SECURITY GUARANTEES & THREAT MODEL
                   ================================================== */}
                {showSecurityModal && (
                    <div className="modal-overlay" onClick={() => setShowSecurityModal(false)}>
                        <div className="modal-content" onClick={e => e.stopPropagation()}>
                            <div className="modal-header">
                                <h3>🛡️ CodeBridge Security Architecture</h3>
                                <button className="close-btn" onClick={() => setShowSecurityModal(false)}>✕</button>
                            </div>
                            <div style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.6, display: "flex", flexDirection: "column", gap: "14px" }}>
                                <div>
                                    <strong style={{ color: "var(--accent-cyan)" }}>1. Cryptographic Token Hashing:</strong>
                                    <p>Sender session tokens and receiver join tokens are stored in the database exclusively as SHA-256 hashes and compared with timing-safe operations to prevent side-channel timing attacks.</p>
                                </div>
                                <div>
                                    <strong style={{ color: "var(--accent-cyan)" }}>2. Real-Time Sender Approval:</strong>
                                    <p>Entering the 6-digit code initiates a pending request. The receiver cannot list, inspect, or download any files until the sender explicitly clicks 'Approve' in their active session.</p>
                                </div>
                                <div>
                                    <strong style={{ color: "var(--accent-cyan)" }}>3. Atomic One-Time Downloads:</strong>
                                    <p>File downloads are guarded by atomic database operations. Even under high-concurrency race conditions, a single-use file can never be downloaded twice.</p>
                                </div>
                                <div>
                                    <strong style={{ color: "var(--accent-cyan)" }}>4. Client-Side End-to-End Encryption (AES-GCM):</strong>
                                    <p>When enabled, encryption happens entirely in the browser using the Web Crypto API. The server stores only raw ciphertext and never possesses the decryption key.</p>
                                </div>
                                <div>
                                    <strong style={{ color: "var(--accent-cyan)" }}>5. Automated Ephemeral Purge:</strong>
                                    <p>Transfers are hard-limited to 10 minutes. A background daemon runs every 60 seconds to completely delete storage objects and metadata from disk and database.</p>
                                </div>
                            </div>
                            <button className="btn-primary" style={{ marginTop: "20px" }} onClick={() => setShowSecurityModal(false)}>
                                Close Security Overview
                            </button>
                        </div>
                    </div>
                )}

                {/* ==================================================
                    FLOATING AI ASSISTANT DRAWER
                   ================================================== */}
                {showAssistant && (
                    <div className="assistant-panel">
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "8px" }}>
                            <span style={{ fontWeight: 700, fontSize: "14px", color: "var(--accent-cyan)" }}>🤖 CodeBridge Assistant</span>
                            <button onClick={() => setShowAssistant(false)} style={{ background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>✕</button>
                        </div>

                        <div className="assistant-body">
                            {assistantResponse ? (
                                <div style={{ background: "var(--bg-input)", padding: "12px", borderRadius: "8px", marginBottom: "12px" }}>
                                    <p>{assistantResponse.answer}</p>
                                </div>
                            ) : (
                                <p style={{ color: "var(--text-muted)" }}>Ask a question about transfers, security, or encryption:</p>
                            )}

                            <div className="quick-questions">
                                <button className="quick-q-btn" onClick={() => handleAskAssistant("How do I send files?")}>
                                    💡 How do I send files?
                                </button>
                                <button className="quick-q-btn" onClick={() => handleAskAssistant("Why is sender approval required?")}>
                                    🛡️ Why is sender approval required?
                                </button>
                                <button className="quick-q-btn" onClick={() => handleAskAssistant("What is End-to-End Encryption?")}>
                                    🔒 What is End-to-End Encryption?
                                </button>
                                <button className="quick-q-btn" onClick={() => handleAskAssistant("Why did my transfer expire?")}>
                                    ⏱️ Why did my transfer expire?
                                </button>
                            </div>
                        </div>

                        <div style={{ display: "flex", gap: "6px" }}>
                            <input
                                type="text"
                                placeholder="Type a question..."
                                value={assistantQuery}
                                onChange={(e) => setAssistantQuery(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && handleAskAssistant()}
                                style={{
                                    flex: 1,
                                    background: "var(--bg-input)",
                                    border: "1px solid var(--border-subtle)",
                                    borderRadius: "8px",
                                    padding: "8px 10px",
                                    color: "#FFF",
                                    fontSize: "12px"
                                }}
                            />
                            <button className="btn-primary" style={{ width: "auto", padding: "8px 12px" }} onClick={() => handleAskAssistant()}>
                                Ask
                            </button>
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}

export default App;