import axios from 'axios';
import { useContext, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AppContext } from '../context/AppContext';
import { toast } from 'react-toastify';

// Landing page after Stripe checkout. The URL's `success` flag is only used to
// decide what to show; the server asks Stripe whether the payment really went through.
const Verify = () => {

    const [searchParams] = useSearchParams()

    const success = searchParams.get("success")
    const transactionId = searchParams.get("transactionId")

    const { backendUrl, loadCreditsData, token } = useContext(AppContext)

    const navigate = useNavigate()

    useEffect(() => {

        if (!token) {
            toast.info('Please log in, then open your payment confirmation link again')
            navigate('/')
            return
        }

        if (success !== 'true' || !transactionId) {
            toast.info('Payment cancelled')
            navigate('/')
            return
        }

        // Function to verify stripe payment
        const verifyStripe = async () => {
            try {

                const { data } = await axios.post(backendUrl + "/api/user/verify-stripe", { success, transactionId }, { headers: { token } })

                if (data.success) {
                    toast.success(data.message)
                    loadCreditsData()
                } else {
                    toast.error(data.message)
                }

            } catch (error) {
                toast.error(error.message)
                console.log(error)
            }

            navigate("/")
        }

        verifyStripe()
    }, [token, success, transactionId, backendUrl, loadCreditsData, navigate])

    return (
        <div className='min-h-[60vh] flex items-center justify-center'>
            <div className="w-20 h-20 border-4 border-gray-300 border-t-4 border-t-blue-600 rounded-full animate-spin"></div>
        </div>
    )
}

export default Verify
