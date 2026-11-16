import userModel from "../models/userModel.js"
import transactionModel from "../models/transactionModel.js"
import razorpay from 'razorpay';
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import stripe from "stripe";
import { getPlan, CURRENCY } from "../configs/plans.js"

const TOKEN_EXPIRY = '7d'
const MIN_PASSWORD_LENGTH = 8

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0
const normalizeEmail = (email) => email.trim().toLowerCase()
const signToken = (user) => jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY })

// API to register user
const registerUser = async (req, res) => {

    try {
        const { name, email, password } = req.body;

        // checking for all data to register user (and that they are plain strings)
        if (!isNonEmptyString(name) || !isNonEmptyString(email) || !isNonEmptyString(password)) {
            return res.json({ success: false, message: 'Missing Details' })
        }

        if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
            return res.json({ success: false, message: 'Enter a valid email' })
        }

        if (password.length < MIN_PASSWORD_LENGTH) {
            return res.json({ success: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` })
        }

        // hashing user password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt)

        const newUser = new userModel({
            name: name.trim(),
            email: normalizeEmail(email),
            password: hashedPassword,
        })
        const user = await newUser.save()

        res.json({ success: true, token: signToken(user), user: { name: user.name } })

    } catch (error) {
        // Duplicate email (unique index) - don't leak raw database errors
        if (error?.code === 11000) {
            return res.json({ success: false, message: 'An account with this email already exists' })
        }
        console.log(error)
        res.json({ success: false, message: 'Registration failed. Please try again' })
    }
}

// API to login user
const loginUser = async (req, res) => {

    try {
        const { email, password } = req.body;

        if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
            return res.json({ success: false, message: 'Missing Details' })
        }

        // Also match the email exactly as typed so accounts created before
        // emails were lower-cased can still log in
        const user = await userModel.findOne({ email: { $in: [normalizeEmail(email), email.trim()] } })

        // Same message for unknown email and wrong password (no account enumeration)
        if (!user) {
            return res.json({ success: false, message: "Invalid credentials" })
        }

        const isMatch = await bcrypt.compare(password, user.password)

        if (isMatch) {
            res.json({ success: true, token: signToken(user), user: { name: user.name } })
        }
        else {
            res.json({ success: false, message: "Invalid credentials" })
        }
    } catch (error) {
        console.log(error)
        res.json({ success: false, message: 'Login failed. Please try again' })
    }
}

// API Controller function to get user available credits data
const userCredits = async (req, res) => {
    try {

        const { userId } = req.body

        // Fetching userdata using userId
        const user = await userModel.findById(userId)

        if (!user) {
            return res.json({ success: false, message: 'User not found. Login Again' })
        }

        res.json({ success: true, credits: user.creditBalance, user: { name: user.name } })

    } catch (error) {
        console.log(error.message)
        res.json({ success: false, message: error.message })
    }
}

// Gateways are created lazily so the server still starts (and the other
// gateway still works) when only one of them is configured.
let razorpayInstance
const getRazorpay = () => {
    if (!razorpayInstance) {
        if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
            throw new Error('Razorpay is not configured')
        }
        razorpayInstance = new razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        })
    }
    return razorpayInstance
}

let stripeInstance
const getStripe = () => {
    if (!stripeInstance) {
        if (!process.env.STRIPE_SECRET_KEY) {
            throw new Error('Stripe is not configured')
        }
        stripeInstance = new stripe(process.env.STRIPE_SECRET_KEY)
    }
    return stripeInstance
}

// Where Stripe sends the customer back to. Taken from config, not from the
// request, so it can't be pointed at another site via a forged Origin header.
const getClientUrl = (req) => {
    const configured = process.env.CLIENT_URL?.split(',')[0]?.trim()
    return (configured || req.headers.origin || '').replace(/\/$/, '')
}

// Credits a paid transaction exactly once.
// The "payment: false -> true" flip is a single atomic database operation, so
// two simultaneous verify calls cannot both succeed and double-credit.
// Returns true if this call added the credits, false if it was already done.
const creditPaidTransaction = async (transactionId) => {
    const claimed = await transactionModel.findOneAndUpdate(
        { _id: transactionId, payment: false },
        { payment: true },
        { new: true }
    )

    if (!claimed) {
        return false
    }

    try {
        await userModel.findByIdAndUpdate(claimed.userId, { $inc: { creditBalance: claimed.credits } })
    } catch (error) {
        // Give the transaction back so a retry can credit it, instead of
        // leaving a paid order that never delivered credits.
        await transactionModel.findByIdAndUpdate(claimed._id, { payment: false })
        throw error
    }

    return true
}

// Payment API to add credits ( Razorpay )
const paymentRazorpay = async (req, res) => {
    try {

        const { userId, planId } = req.body

        const userData = await userModel.findById(userId)

        // checking for planId and userdata
        if (!userData || !planId) {
            return res.json({ success: false, message: 'Missing Details' })
        }

        // Price and credits always come from the server-side plan table
        const selected = getPlan(planId)
        if (!selected) {
            return res.json({ success: false, message: 'plan not found' })
        }

        // Creating Transaction Data
        const newTransaction = await transactionModel.create({
            userId,
            plan: selected.plan,
            amount: selected.amount,
            credits: selected.credits,
            date: Date.now()
        })

        // Creating razorpay Order
        const order = await getRazorpay().orders.create({
            amount: selected.amount * 100,
            currency: CURRENCY,
            receipt: String(newTransaction._id),
        })

        await transactionModel.findByIdAndUpdate(newTransaction._id, { razorpayOrderId: order.id })

        res.json({ success: true, order });

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error?.error?.description || error.message })
    }
}

// API Controller function to verify razorpay payment
const verifyRazorpay = async (req, res) => {
    try {

        const { userId, razorpay_order_id } = req.body;

        if (!isNonEmptyString(razorpay_order_id)) {
            return res.json({ success: false, message: 'Missing Details' })
        }

        // The order must be one we created, for the logged-in user
        const transactionData = await transactionModel.findOne({ razorpayOrderId: razorpay_order_id })
        if (!transactionData || transactionData.userId !== String(userId)) {
            return res.json({ success: false, message: 'Transaction not found' })
        }

        // Ask Razorpay directly (server to server) whether the order is paid
        const orderInfo = await getRazorpay().orders.fetch(razorpay_order_id);

        if (orderInfo.status !== 'paid') {
            return res.json({ success: false, message: 'Payment Failed' });
        }

        const added = await creditPaidTransaction(transactionData._id)
        if (!added) {
            return res.json({ success: false, message: 'Payment Already Verified' })
        }

        res.json({ success: true, message: "Credits Added" });

    } catch (error) {
        console.log(error);
        res.json({ success: false, message: error?.error?.description || error.message });
    }
}

// Payment API to add credits ( Stripe )
const paymentStripe = async (req, res) => {
    try {

        const { userId, planId } = req.body

        const userData = await userModel.findById(userId)

        // checking for planId and userdata
        if (!userData || !planId) {
            return res.json({ success: false, message: 'Invalid Credentials' })
        }

        const selected = getPlan(planId)
        if (!selected) {
            return res.json({ success: false, message: 'plan not found' })
        }

        const clientUrl = getClientUrl(req)
        if (!clientUrl) {
            return res.json({ success: false, message: 'Client URL is not configured' })
        }

        // Creating Transaction Data
        const newTransaction = await transactionModel.create({
            userId,
            plan: selected.plan,
            amount: selected.amount,
            credits: selected.credits,
            date: Date.now()
        })

        // Creating line items to for Stripe
        const line_items = [{
            price_data: {
                currency: CURRENCY.toLowerCase(),
                product_data: {
                    name: `${selected.plan} plan - ${selected.credits} credits`
                },
                unit_amount: selected.amount * 100
            },
            quantity: 1
        }]

        const session = await getStripe().checkout.sessions.create({
            success_url: `${clientUrl}/verify?success=true&transactionId=${newTransaction._id}`,
            cancel_url: `${clientUrl}/verify?success=false&transactionId=${newTransaction._id}`,
            line_items: line_items,
            mode: 'payment',
            metadata: { transactionId: String(newTransaction._id) },
        })

        // Remember which Stripe session belongs to this transaction
        await transactionModel.findByIdAndUpdate(newTransaction._id, { stripeSessionId: session.id })

        res.json({ success: true, session_url: session.url });

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API Controller function to verify stripe payment
// NOTE: the `success` flag in the redirect URL is NOT trusted. The payment
// status is read from Stripe itself.
const verifyStripe = async (req, res) => {
    try {

        const { userId, transactionId } = req.body

        if (!isNonEmptyString(transactionId)) {
            return res.json({ success: false, message: 'Missing Details' })
        }

        // Invalid ObjectId strings throw a CastError, handled below
        const transactionData = await transactionModel.findById(transactionId)

        // Must exist, belong to the logged-in user and have a Stripe session
        if (!transactionData || transactionData.userId !== String(userId) || !transactionData.stripeSessionId) {
            return res.json({ success: false, message: 'Transaction not found' })
        }

        if (transactionData.payment) {
            return res.json({ success: false, message: 'Payment Already Verified' })
        }

        const session = await getStripe().checkout.sessions.retrieve(transactionData.stripeSessionId)

        if (session.payment_status !== 'paid') {
            return res.json({ success: false, message: 'Payment Failed' });
        }

        const added = await creditPaidTransaction(transactionData._id)
        if (!added) {
            return res.json({ success: false, message: 'Payment Already Verified' })
        }

        res.json({ success: true, message: "Credits Added" });

    } catch (error) {
        console.log(error);
        res.json({ success: false, message: error.message });
    }
}


export { registerUser, loginUser, userCredits, paymentRazorpay, verifyRazorpay, paymentStripe, verifyStripe }
