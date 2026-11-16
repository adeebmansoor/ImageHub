import axios from 'axios'
import FormData from 'form-data'
import userModel from '../models/userModel.js'

// Clipdrop's text-to-image endpoint accepts prompts of up to 1000 characters
const MAX_PROMPT_LENGTH = 1000

// Controller function to generate image from prompt
// http://localhost:4000/api/image/generate-image
export const generateImage = async (req, res) => {

  let reserved = false
  let userId

  try {

    ({ userId } = req.body)
    const { prompt } = req.body

    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.json({ success: false, message: 'Missing Details' })
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.json({ success: false, message: `Prompt is too long (max ${MAX_PROMPT_LENGTH} characters)` })
    }

    // Reserve 1 credit atomically BEFORE calling the paid API. The filter
    // only matches while the balance is above 0, so parallel requests can
    // never spend more credits than the user has.
    const user = await userModel.findOneAndUpdate(
      { _id: userId, creditBalance: { $gt: 0 } },
      { $inc: { creditBalance: -1 } },
      { new: true }
    )

    if (!user) {
      const existing = await userModel.findById(userId)
      if (!existing) {
        return res.json({ success: false, message: 'Missing Details' })
      }
      return res.json({ success: false, message: 'No Credit Balance', creditBalance: Math.max(existing.creditBalance, 0) })
    }

    reserved = true

    // Creation of new multi/part formdata
    const formdata = new FormData()
    formdata.append('prompt', prompt.trim())

    // Calling Clipdrop API
    const { data } = await axios.post('https://clipdrop-api.co/text-to-image/v1', formdata, {
      headers: {
        'x-api-key': process.env.CLIPDROP_API,
        ...formdata.getHeaders(),
      },
      responseType: "arraybuffer"
    })

    // Convertion of arrayBuffer to base64
    const base64Image = Buffer.from(data, 'binary').toString('base64');
    const resultImage = `data:image/png;base64,${base64Image}`

    // Sending Response
    res.json({ success: true, message: "Image generated", resultImage, creditBalance: user.creditBalance })

  } catch (error) {
    console.log(error.message)

    // The image was not delivered, so give the credit back
    if (reserved) {
      try {
        await userModel.findByIdAndUpdate(userId, { $inc: { creditBalance: 1 } })
      } catch (refundError) {
        console.log('Credit refund failed:', refundError.message)
      }
    }

    res.json({ success: false, message: 'Image generation failed. Your credit was not charged' })
  }
}
