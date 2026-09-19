const { io } = require("socket.io-client");

const transferId = process.argv[2];

if (!transferId) {
    console.log("Usage: node socket-test.js <transferId>");
    process.exit(1);
}

const socket = io("http://localhost:5000");

socket.on("connect", () => {

    console.log("🔌 Connected to CodeBridge");
    console.log("Socket ID:", socket.id);

    socket.emit(
        "join-transfer",
        transferId
    );

    console.log(
        "📡 Joined transfer room:",
        transferId
    );
});

socket.on(
    "receiver-joined",
    (data) => {

        console.log(
            "🟢 RECEIVER JOINED!"
        );

        console.log(data);

    }
);

socket.on("disconnect", () => {

    console.log(
        "🔌 Disconnected from server"
    );

});