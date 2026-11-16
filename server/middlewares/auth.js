import jwt from 'jsonwebtoken';

// User authentication middleware
const authUser = async (req, res, next) => {
    // Extract the token from headers
    const { token } = req.headers;

    // Check if the token is missing
    if (!token) {
        return res.json({ success: false, message: 'Not Authorized. Login Again' });
    }

    try {
        // Verify the token using the secret key
        const tokenDecode = jwt.verify(token, process.env.JWT_SECRET);

        // Check if the decoded token contains a user ID
        if (!tokenDecode.id) {
            return res.json({ success: false, message: 'Not Authorized. Login Again' });
        }

        // Attach user ID to the request body (always overwrites anything the
        // client sent under the same name)
        req.body = req.body || {};
        req.body.userId = tokenDecode.id;

        // Call the next function in the stack
        next();
    } catch (error) {
        const message = error.name === 'TokenExpiredError'
            ? 'Session expired. Login Again'
            : 'Not Authorized. Login Again';
        res.json({ success: false, message });
    }
};

// Export the middleware
export default authUser;
