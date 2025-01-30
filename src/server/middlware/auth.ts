import { UserPayload } from '@/server/types';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set');
}

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || JWT_SECRET;

export const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 60 minutes
  max: 5,
  message: 'Too many login attempts, please try again later'
});

// the Request type to use our authenticated user type
declare module 'express' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

// a type for authenticated user data (without password)
type AuthenticatedUser = Omit<UserPayload, 'password'>;

interface JWTPayload extends jwt.JwtPayload {
  username: string;
  domain: string;
  type: 'access' | 'refresh';
}

export const authenticateRequest = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Invalid authorization header format' });
      return;
    }

    const token = authHeader.split(' ')[1];

    if(!token) {
      console.log("invalid token!");
      return;
    }

    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;

    if (decoded.type !== 'access') {
      res.status(401).json({ error: 'Invalid token type' });
      return;
    }

    const { iat, exp, type, ...userData } = decoded;

    req.user = userData as AuthenticatedUser;

    res.setHeader('X-Token-Expired', (Date.now() >= (exp ?? 0) * 1000).toString());

    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      res.status(401).json({
        error: 'Token expired',
        code: 'TOKEN_EXPIRED'
      });
    } else if (error.name === 'JsonWebTokenError') {
      res.status(401).json({
        error: 'Invalid token',
        code: 'INVALID_TOKEN'
      });
    } else {
      res.status(500).json({
        error: 'Authentication error',
        code: 'AUTH_ERROR'
      });
    }
  }
};

export const generateTokens = async (
  user: Omit<UserPayload, 'password'>
): Promise<{ accessToken: string; refreshToken: string }> => {
  const accessToken = jwt.sign(
    { ...user, type: 'access' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const refreshToken = jwt.sign(
    { ...user, type: 'refresh' },
    JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );

  return { accessToken, refreshToken };
};

export const refreshAccessToken = async (
  refreshToken: string
): Promise<string> => {
  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as JWTPayload;

    if (decoded.type !== 'refresh') {
      throw new Error('Invalid token type');
    }

    // new access token
    const { iat, exp, type, ...userData } = decoded;
    const accessToken = jwt.sign(
      { ...userData, type: 'access' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    return accessToken;
  } catch (error) {
    throw new Error('Invalid refresh token');
  }
};

// function to hash passwords
export const hashPassword = async (password: string): Promise<string> => {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
};

// function to verify passwords
export const verifyPassword = async (
  password: string,
  hashedPassword: string
): Promise<boolean> => {
  return bcrypt.compare(password, hashedPassword);
};
