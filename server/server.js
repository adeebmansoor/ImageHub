import 'dotenv/config';
import express from 'express'
import cors from 'cors'
import userRouter from './routes/userRoutes.js';
import connectDB from './configs/mongodb.js';
import imageRouter from './routes/imageRoutes.js';

// Fail fast if the one secret the whole login system depends on is missing
if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set. Add it to server/.env')
}

// App Config
const PORT = process.env.PORT || 4000
const app = express();
await connectDB()

// Behind Vercel / a reverse proxy: needed so rate limiting sees the real client IP
app.set('trust proxy', 1)

// Intialize Middlewares
app.use(express.json({ limit: '100kb' }))

// CLIENT_URL can hold one or more comma-separated origins. When it is not
// set (local development) every origin is allowed, as before.
const allowedOrigins = process.env.CLIENT_URL?.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)
app.use(cors(allowedOrigins?.length ? { origin: allowedOrigins } : undefined))

// API routes
app.use('/api/user',userRouter)
app.use('/api/image',imageRouter)

app.get('/', (req,res) => res.send("API Working"))

// Vercel imports the app; locally (or on any normal host) we listen on a port
if (!process.env.VERCEL) {
    app.listen(PORT, () => console.log('Server running on port ' + PORT));
}

export default app
