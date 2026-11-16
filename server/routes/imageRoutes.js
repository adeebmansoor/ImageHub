import express from 'express'
import { generateImage } from '../controllers/imageController.js'
import authUser from '../middlewares/auth.js'
import { generateLimiter } from '../middlewares/rateLimit.js'

const imageRouter = express.Router()

imageRouter.post('/generate-image', authUser, generateLimiter, generateImage)

export default imageRouter
