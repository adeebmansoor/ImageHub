import rateLimit from 'express-rate-limit'

// Same response shape as the rest of the API (HTTP 200 + success:false)
const handler = (message) => (req, res) => res.json({ success: false, message })

// Login / register: slows down password guessing and mass account creation
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: handler('Too many attempts. Try again in a few minutes'),
})

// Image generation: every call costs real money at Clipdrop
export const generateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: handler('Too many requests. Please slow down'),
})
