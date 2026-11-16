// Single source of truth for credit plans (the client only displays them;
// prices and credits are always taken from here on the server).
export const PLANS = {
    Basic: { plan: 'Basic', credits: 100, amount: 10 },
    Advanced: { plan: 'Advanced', credits: 500, amount: 50 },
    Business: { plan: 'Business', credits: 5000, amount: 250 },
}

export const getPlan = (planId) =>
    typeof planId === 'string' && Object.hasOwn(PLANS, planId) ? PLANS[planId] : null

export const CURRENCY = (process.env.CURRENCY || 'INR').trim()
