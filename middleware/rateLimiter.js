const { rateLimit } = require("express-rate-limit");

// General API Rate Limiter
const apiGeneralLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many requests. Please slow down and try again shortly."
    }
});

// Strict Rate Limiter for Creating Transfers (prevents spam/resource exhaustion)
const createTransferLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30, // max 30 transfers per 15 minutes per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Transfer creation limit exceeded. Please wait before creating another transfer."
    }
});

// Brute-force Protection for 6-Digit Transfer Code Attempts
const joinCodeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per 15 minutes per IP
    standardHeaders: true,
    legacyHeaders: false,
    statusCode: 429,
    message: {
        success: false,
        message: "Too many failed code attempts. Please wait 15 minutes before trying again."
    }
});

// Password verification rate limiter
const passwordAttemptLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    statusCode: 429,
    message: {
        success: false,
        message: "Too many password attempts. Access temporarily locked."
    }
});

// Download endpoint rate limiter
const downloadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Download rate limit reached. Please wait a moment."
    }
});

module.exports = {
    apiGeneralLimiter,
    createTransferLimiter,
    joinCodeLimiter,
    passwordAttemptLimiter,
    downloadLimiter
};
