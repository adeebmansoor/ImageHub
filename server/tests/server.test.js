// Run with:  npm test
//
// These tests replace MongoDB, Stripe, Razorpay and Clipdrop with small
// in-memory fakes, so they need no network, keys or database. They check the
// application logic (who gets credits, and how many times). The atomicity of
// findOneAndUpdate itself is a MongoDB guarantee and is not tested here.
import { test, mock, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'
process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake'
process.env.RAZORPAY_KEY_SECRET = 'fake'
process.env.CURRENCY = 'INR'
process.env.CLIENT_URL = 'https://imagehub.example'
process.env.CLIPDROP_API = 'fake'

// ---------- in-memory fakes ----------
const db = { users: [], transactions: [], seq: 0 }
const gateway = { stripeSessions: {}, razorpayOrders: {}, clipdrop: 'ok' }
const newId = () => String(++db.seq).padStart(24, '0')

const matches = (doc, filter) => Object.entries(filter).every(([k, cond]) => {
    if (cond && typeof cond === 'object' && '$gt' in cond) return doc[k] > cond.$gt
    if (cond && typeof cond === 'object' && '$in' in cond) return cond.$in.includes(doc[k])
    return doc[k] === cond
})
const applyUpdate = (doc, update) => {
    for (const [k, v] of Object.entries(update)) {
        if (k === '$inc') for (const [f, n] of Object.entries(v)) doc[f] += n
        else doc[k] = v
    }
    return doc
}
const makeModel = (store, defaults = {}) => {
    const M = class {
        constructor(data) { Object.assign(this, defaults, data) }
        async save() {
            if (store === 'users' && db.users.some((u) => u.email === this.email)) {
                throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
            }
            this._id = newId(); db[store].push(this); return this
        }
        static async create(data) { return new M(data).save() }
        static async findById(id) {
            if (!/^\d{24}$/.test(String(id))) throw new Error('Cast to ObjectId failed')
            return db[store].find((d) => d._id === String(id)) ?? null
        }
        static async findOne(filter) { return db[store].find((d) => matches(d, filter)) ?? null }
        static async findOneAndUpdate(filter, update) {
            const doc = db[store].find((d) => matches(d, filter))
            return doc ? applyUpdate(doc, update) : null
        }
        static async findByIdAndUpdate(id, update) {
            const doc = db[store].find((d) => d._id === String(id))
            return doc ? applyUpdate(doc, update) : null
        }
    }
    return M
}
const userModel = makeModel('users', { creditBalance: 5 })
const transactionModel = makeModel('transactions', { payment: false })

class FakeStripe {
    constructor() {
        this.checkout = {
            sessions: {
                create: async (opts) => {
                    const id = 'cs_' + newId()
                    gateway.stripeSessions[id] = { id, payment_status: 'unpaid', url: 'https://checkout.stripe.test/' + id, opts }
                    return gateway.stripeSessions[id]
                },
                retrieve: async (id) => gateway.stripeSessions[id],
            },
        }
    }
}
class FakeRazorpay {
    constructor() {
        this.orders = {
            create: async (opts) => {
                const id = 'order_' + newId()
                gateway.razorpayOrders[id] = { id, status: 'created', ...opts }
                return gateway.razorpayOrders[id]
            },
            fetch: async (id) => gateway.razorpayOrders[id],
        }
    }
}

const url = (p) => new URL(p, import.meta.url).href
mock.module(url('../models/userModel.js'), { defaultExport: userModel })
mock.module(url('../models/transactionModel.js'), { defaultExport: transactionModel })
mock.module('stripe', { defaultExport: FakeStripe })
mock.module('razorpay', { defaultExport: FakeRazorpay })
mock.module('axios', {
    defaultExport: {
        post: async () => {
            await new Promise((r) => setTimeout(r, 5))
            if (gateway.clipdrop === 'fail') throw new Error('Clipdrop down')
            return { data: Buffer.from('png-bytes') }
        },
    },
})

const U = await import('../controllers/UserController.js')
const I = await import('../controllers/imageController.js')
const { default: authUser } = await import('../middlewares/auth.js')
const { getPlan } = await import('../configs/plans.js')
const { default: jwt } = await import('jsonwebtoken')

const call = async (handler, body = {}, headers = {}) => {
    const res = { body: null, json(o) { this.body = o; return this } }
    await handler({ body: { ...body }, headers }, res)
    return res.body
}
const addUser = (over = {}) => {
    const u = new userModel({ name: 'A', email: `u${db.seq}@x.com`, password: 'x', ...over })
    u._id = newId(); db.users.push(u); return u
}
const stripeCheckout = async (user, planId = 'Basic') => {
    const r = await call(U.paymentStripe, { userId: user._id, planId })
    assert.equal(r.success, true)
    const tx = db.transactions.at(-1)
    return { tx, session: gateway.stripeSessions[tx.stripeSessionId] }
}

beforeEach(() => {
    db.users.length = 0; db.transactions.length = 0
    gateway.stripeSessions = {}; gateway.razorpayOrders = {}; gateway.clipdrop = 'ok'
})

describe('Stripe verification', () => {
    test('free-credits exploit is blocked: success=true without paying gives nothing', async () => {
        const user = addUser()
        const { tx } = await stripeCheckout(user, 'Business')
        const r = await call(U.verifyStripe, { userId: user._id, transactionId: tx._id, success: 'true' })
        assert.equal(r.success, false)
        assert.equal(user.creditBalance, 5)
        assert.equal(tx.payment, false)
    })

    test('a paid session adds the plan credits exactly once', async () => {
        const user = addUser()
        const { tx, session } = await stripeCheckout(user, 'Advanced')
        session.payment_status = 'paid'
        const first = await call(U.verifyStripe, { userId: user._id, transactionId: tx._id })
        const second = await call(U.verifyStripe, { userId: user._id, transactionId: tx._id })
        assert.equal(first.success, true)
        assert.equal(second.success, false)
        assert.equal(user.creditBalance, 5 + 500)
    })

    test('simultaneous verify calls credit once', async () => {
        const user = addUser()
        const { tx, session } = await stripeCheckout(user)
        session.payment_status = 'paid'
        const results = await Promise.all(
            Array.from({ length: 10 }, () => call(U.verifyStripe, { userId: user._id, transactionId: tx._id }))
        )
        assert.equal(results.filter((r) => r.success).length, 1)
        assert.equal(user.creditBalance, 5 + 100)
    })

    test("cannot verify another user's transaction", async () => {
        const owner = addUser(); const other = addUser()
        const { tx, session } = await stripeCheckout(owner)
        session.payment_status = 'paid'
        const r = await call(U.verifyStripe, { userId: other._id, transactionId: tx._id })
        assert.equal(r.success, false)
        assert.equal(owner.creditBalance, 5)
        assert.equal(other.creditBalance, 5)
    })

    test('garbage transaction ids fail cleanly', async () => {
        const user = addUser()
        assert.equal((await call(U.verifyStripe, { userId: user._id, transactionId: 'nope' })).success, false)
        assert.equal((await call(U.verifyStripe, { userId: user._id, transactionId: { $ne: null } })).success, false)
    })

    test('redirect URLs use CLIENT_URL, not a forged Origin header', async () => {
        const user = addUser()
        const res = { body: null, json(o) { this.body = o } }
        await U.paymentStripe({ body: { userId: user._id, planId: 'Basic' }, headers: { origin: 'https://evil.test' } }, res)
        const { opts } = gateway.stripeSessions[db.transactions[0].stripeSessionId]
        assert.ok(opts.success_url.startsWith('https://imagehub.example/verify'))
        assert.ok(!opts.success_url.includes('evil'))
    })
})

describe('Razorpay verification', () => {
    const checkout = async (user, planId = 'Basic') => {
        const r = await call(U.paymentRazorpay, { userId: user._id, planId })
        assert.equal(r.success, true)
        return { order: r.order, tx: db.transactions.at(-1) }
    }

    test('unpaid order gives nothing; paid order credits once even in parallel', async () => {
        const user = addUser()
        const { order } = await checkout(user)
        assert.equal((await call(U.verifyRazorpay, { userId: user._id, razorpay_order_id: order.id })).success, false)
        assert.equal(user.creditBalance, 5)

        gateway.razorpayOrders[order.id].status = 'paid'
        const results = await Promise.all(
            Array.from({ length: 10 }, () => call(U.verifyRazorpay, { userId: user._id, razorpay_order_id: order.id }))
        )
        assert.equal(results.filter((r) => r.success).length, 1)
        assert.equal(user.creditBalance, 5 + 100)
    })

    test('unknown order ids and other users are rejected', async () => {
        const owner = addUser(); const other = addUser()
        const { order } = await checkout(owner)
        gateway.razorpayOrders[order.id].status = 'paid'
        assert.equal((await call(U.verifyRazorpay, { userId: owner._id, razorpay_order_id: 'order_unknown' })).success, false)
        assert.equal((await call(U.verifyRazorpay, { userId: other._id, razorpay_order_id: order.id })).success, false)
        assert.equal(owner.creditBalance, 5)
    })

    test('receipt is a string', async () => {
        const user = addUser()
        const { order } = await checkout(user)
        assert.equal(typeof order.receipt, 'string')
    })
})

describe('Plans', () => {
    test('only the three real plans resolve (no prototype keys)', () => {
        for (const id of ['Basic', 'Advanced', 'Business']) assert.ok(getPlan(id))
        for (const id of ['constructor', '__proto__', 'toString', 'basic', '', null, undefined, { a: 1 }]) {
            assert.equal(getPlan(id), null)
        }
    })
})

describe('Image generation credits', () => {
    test('parallel requests cannot spend more credits than the balance', async () => {
        const user = addUser({ creditBalance: 1 })
        const results = await Promise.all(
            Array.from({ length: 8 }, () => call(I.generateImage, { userId: user._id, prompt: 'a cat' }))
        )
        assert.equal(results.filter((r) => r.success).length, 1)
        assert.equal(user.creditBalance, 0)
        assert.ok(results.filter((r) => !r.success).every((r) => r.message === 'No Credit Balance' && r.creditBalance === 0))
    })

    test('a negative balance is blocked and reported as 0', async () => {
        const user = addUser({ creditBalance: -3 })
        const r = await call(I.generateImage, { userId: user._id, prompt: 'a cat' })
        assert.equal(r.success, false)
        assert.equal(r.creditBalance, 0)
        assert.equal(user.creditBalance, -3)
    })

    test('one credit is charged on success and the new balance is returned', async () => {
        const user = addUser({ creditBalance: 5 })
        const r = await call(I.generateImage, { userId: user._id, prompt: 'a cat' })
        assert.equal(r.success, true)
        assert.equal(r.message, 'Image generated')
        assert.equal(r.creditBalance, 4)
        assert.ok(r.resultImage.startsWith('data:image/png;base64,'))
    })

    test('the credit is refunded when Clipdrop fails', async () => {
        const user = addUser({ creditBalance: 5 })
        gateway.clipdrop = 'fail'
        const r = await call(I.generateImage, { userId: user._id, prompt: 'a cat' })
        assert.equal(r.success, false)
        assert.equal(user.creditBalance, 5)
    })

    test('bad prompts are rejected without touching credits', async () => {
        const user = addUser({ creditBalance: 5 })
        for (const prompt of ['', '   ', undefined, 42, { a: 1 }, 'x'.repeat(1001)]) {
            assert.equal((await call(I.generateImage, { userId: user._id, prompt })).success, false)
        }
        assert.equal(user.creditBalance, 5)
    })
})

describe('Accounts', () => {
    test('register validates input, lower-cases the email and rejects duplicates', async () => {
        assert.equal((await call(U.registerUser, { name: 'A', email: 'a@x.com', password: 'short' })).success, false)
        assert.equal((await call(U.registerUser, { name: 'A', email: 'not-an-email', password: 'longenough1' })).success, false)
        assert.equal((await call(U.registerUser, { name: 'A', email: { $ne: null }, password: 'longenough1' })).success, false)

        const ok = await call(U.registerUser, { name: 'A', email: ' Mixed@Case.COM ', password: 'longenough1' })
        assert.equal(ok.success, true)
        assert.equal(db.users[0].email, 'mixed@case.com')

        const dup = await call(U.registerUser, { name: 'B', email: 'MIXED@case.com', password: 'longenough1' })
        assert.equal(dup.success, false)
        assert.ok(!/E11000/.test(dup.message))
    })

    test('login: same message for unknown email and wrong password, token expires', async () => {
        await call(U.registerUser, { name: 'A', email: 'a@x.com', password: 'longenough1' })
        const wrongPw = await call(U.loginUser, { email: 'a@x.com', password: 'wrongwrong1' })
        const noUser = await call(U.loginUser, { email: 'nobody@x.com', password: 'longenough1' })
        const injection = await call(U.loginUser, { email: { $ne: null }, password: 'longenough1' })
        assert.equal(wrongPw.message, 'Invalid credentials')
        assert.equal(noUser.message, 'Invalid credentials')
        assert.equal(injection.success, false)

        const ok = await call(U.loginUser, { email: 'A@X.com', password: 'longenough1' })
        assert.equal(ok.success, true)
        assert.ok(jwt.decode(ok.token).exp, 'token must have an expiry')
    })

    test('older accounts stored with a mixed-case email can still log in', async () => {
        const hash = await (await import('bcrypt')).default.hash('longenough1', 4)
        addUser({ email: 'Legacy@X.com', password: hash })
        assert.equal((await call(U.loginUser, { email: 'Legacy@X.com', password: 'longenough1' })).success, true)
    })
})

describe('Auth middleware', () => {
    const run = async (headers, body = {}) => {
        const req = { headers, body }
        let nextCalled = false
        const res = { body: null, json(o) { this.body = o } }
        await authUser(req, res, () => { nextCalled = true })
        return { req, res, nextCalled }
    }

    test('accepts a valid token and overwrites a spoofed userId', async () => {
        const token = jwt.sign({ id: 'real-id' }, process.env.JWT_SECRET, { expiresIn: '1h' })
        const { req, nextCalled } = await run({ token }, { userId: 'attacker-chosen' })
        assert.equal(nextCalled, true)
        assert.equal(req.body.userId, 'real-id')
    })

    test('rejects missing, forged and expired tokens', async () => {
        assert.equal((await run({})).nextCalled, false)
        const forged = jwt.sign({ id: 'x' }, 'wrong-secret')
        assert.equal((await run({ token: forged })).nextCalled, false)
        const expired = jwt.sign({ id: 'x' }, process.env.JWT_SECRET, { expiresIn: -10 })
        const r = await run({ token: expired })
        assert.equal(r.nextCalled, false)
        assert.match(r.res.body.message, /expired/i)
    })

    test('body may be undefined (e.g. GET requests)', async () => {
        const token = jwt.sign({ id: 'real-id' }, process.env.JWT_SECRET)
        const req = { headers: { token } }
        await authUser(req, { json() {} }, () => {})
        assert.equal(req.body.userId, 'real-id')
    })
})
