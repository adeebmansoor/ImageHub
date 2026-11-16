import { createContext, useCallback, useEffect, useState } from "react";
import axios from 'axios'
import { toast } from 'react-toastify'
import { useNavigate } from "react-router-dom";

// eslint-disable-next-line react-refresh/only-export-components
export const AppContext = createContext()

const AppContextProvider = ({ children }) => {

    const [showLogin, setShowLogin] = useState(false)
    const [token, setToken] = useState(localStorage.getItem('token'))
    const [user, setUser] = useState(null)

    const [credit, setCredit] = useState(false)

    const backendUrl = import.meta.env.VITE_BACKEND_URL
    const navigate = useNavigate()

    const logout = useCallback(() => {
        localStorage.removeItem('token')
        setToken('')
        setUser(null)
        setCredit(false)
    }, [])

    const loadCreditsData = useCallback(async () => {
        if (!token) return

        try {

            const { data } = await axios.get(backendUrl + '/api/user/credits', { headers: { token } })
            if (data.success) {
                setCredit(data.credits)
                setUser(data.user)
            } else {
                // Token is invalid or expired: sign the user out instead of
                // leaving them half logged in
                logout()
                toast.error(data.message)
            }

        } catch (error) {
            console.log(error)
            toast.error(error.message)
        }
    }, [token, backendUrl, logout])

    const generateImage = async (prompt) => {
        try {

            const { data } = await axios.post(backendUrl + '/api/image/generate-image', { prompt }, { headers: { token } })

            if (data.success) {
                loadCreditsData()
                return data.resultImage
            } else {
                toast.error(data.message)
                loadCreditsData()
                if (data.creditBalance === 0) {
                    navigate('/buy')
                }
            }

        } catch (error) {
            toast.error(error.message)
        }
    }

    useEffect(() => {
        if (token) {
            loadCreditsData()
        }
    }, [token, loadCreditsData])

    const value = {
        token, setToken,
        user, setUser,
        showLogin, setShowLogin,
        credit, setCredit,
        loadCreditsData,
        backendUrl,
        generateImage,
        logout
    }

    return (
        <AppContext.Provider value={value}>
            {children}
        </AppContext.Provider>
    )

}

export default AppContextProvider
