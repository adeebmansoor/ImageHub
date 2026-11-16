import mongoose from "mongoose";

const connectDB = async () => {

    if (!process.env.MONGODB_URI) {
        throw new Error('MONGODB_URI is not set')
    }

    mongoose.connection.on('connected', () => {
        console.log("Database Connected");
    })

    // dbName keeps working with URIs that already contain a path or query
    // string (e.g. Atlas "...mongodb.net/?retryWrites=true&w=majority").
    await mongoose.connect(process.env.MONGODB_URI, { dbName: 'ai-image' })

}

export default connectDB;
