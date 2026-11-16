import express from 'express'
import {
    userCredits,
    paymentRazorpay,
    verifyRazorpay,
    registerUser,
    loginUser,
    paymentStripe,
    verifyStripe
} from '../controllers/UserController.js'
import authUser from '../middlewares/auth.js'
import { authLimiter } from '../middlewares/rateLimit.js'

const userRouter = express.Router()

userRouter.post('/register', authLimiter, registerUser)
userRouter.post('/login', authLimiter, loginUser)
userRouter.get('/credits', authUser, userCredits)
userRouter.post('/pay-razor', authUser, paymentRazorpay)
userRouter.post('/verify-razor', authUser, verifyRazorpay)
userRouter.post('/pay-stripe', authUser, paymentStripe)
userRouter.post('/verify-stripe', authUser, verifyStripe)

export default userRouter
