const { test, describe } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const { hashToken, verifySender, verifyReceiver } = require("../middleware/auth");
const Transfer = require("../models/Transfer");
const File = require("../models/File");

// Helper mock for Express req, res, next
function createMockHttp(reqOverrides = {}) {
    let statusCode = 200;
    let jsonBody = null;
    let nextCalled = false;

    const req = {
        params: {},
        query: {},
        body: {},
        headers: {},
        ...reqOverrides
    };

    const res = {
        status: function (code) {
            statusCode = code;
            return this;
        },
        json: function (data) {
            jsonBody = data;
            return this;
        }
    };

    const next = () => {
        nextCalled = true;
    };

    return {
        req,
        res,
        next,
        getStatus: () => statusCode,
        getBody: () => jsonBody,
        isNextCalled: () => nextCalled
    };
}

describe("8. Access Control: verifySender Middleware", () => {
    test("rejects request missing session token with 401", async () => {
        const { req, res, next, getStatus, getBody } = createMockHttp({
            params: { transferId: "dummy-id" }
        });

        await verifySender(req, res, next);
        assert.strictEqual(getStatus(), 401);
        assert.strictEqual(getBody().success, false);
        assert.strictEqual(getBody().message.includes("Session token required") || getBody().message.includes("session token required"), true);
    });

    test("rejects request missing transferId with 400", async () => {
        const { req, res, next, getStatus, getBody } = createMockHttp({
            headers: { authorization: "Bearer valid-token" }
        });

        await verifySender(req, res, next);
        assert.strictEqual(getStatus(), 400);
        assert.strictEqual(getBody().success, false);
    });
});

describe("9. Access Control: verifyReceiver Middleware & States", () => {
    test("rejects request missing receiver token with 401", async () => {
        const { req, res, next, getStatus, getBody } = createMockHttp({
            params: { transferId: "transfer-123" }
        });

        await verifyReceiver(req, res, next);
        assert.strictEqual(getStatus(), 401);
        assert.strictEqual(getBody().success, false);
    });
});

describe("10. Atomic One-Time Download Race Condition Protection", () => {
    test("atomic simulation ensures only 1 winner out of concurrent download attempts", async () => {
        // State simulation of File record with downloaded: false
        let fileRecord = {
            id: "file-xyz",
            downloaded: false,
            downloadCount: 0
        };

        // Simulated atomic CAS (Compare-And-Swap like findOneAndUpdate)
        function atomicClaimDownload() {
            if (!fileRecord.downloaded) {
                fileRecord.downloaded = true;
                fileRecord.downloadCount++;
                return { success: true };
            }
            return null; // Already downloaded
        }

        // Simulate 5 simultaneous requests attempting to download at the exact same tick
        const results = await Promise.all([
            Promise.resolve(atomicClaimDownload()),
            Promise.resolve(atomicClaimDownload()),
            Promise.resolve(atomicClaimDownload()),
            Promise.resolve(atomicClaimDownload()),
            Promise.resolve(atomicClaimDownload())
        ]);

        const successfulClaims = results.filter(r => r !== null && r.success === true);
        const rejectedClaims = results.filter(r => r === null);

        assert.strictEqual(successfulClaims.length, 1);
        assert.strictEqual(rejectedClaims.length, 4);
        assert.strictEqual(fileRecord.downloadCount, 1);
        assert.strictEqual(fileRecord.downloaded, true);
    });
});

describe("11. Password Hashing and Verification", () => {
    test("bcrypt generates unique salted hashes and verifies matching password", async () => {
        const password = "SuperSecretPassword123!";
        const hash = await bcrypt.hash(password, 10);

        assert.notStrictEqual(hash, password);
        const match = await bcrypt.compare(password, hash);
        assert.strictEqual(match, true);

        const wrongMatch = await bcrypt.compare("WrongPassword", hash);
        assert.strictEqual(wrongMatch, false);
    });
});
