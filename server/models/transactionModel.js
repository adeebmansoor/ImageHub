import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    plan: { type: String, required: true },
    amount: { type: Number, required: true },
    credits: { type: Number, required: true },
    payment: { type: Boolean, default: false },
    date: { type: Number },
    // Gateway references, used to verify payments server-side
    stripeSessionId: { type: String },
    razorpayOrderId: { type: String },
})

const transactionModel = mongoose.models.transaction || mongoose.model("transaction", transactionSchema);

export default transactionModel;
