import { UserPayload } from '@/server/types';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

export const authenticateRequest = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.headers.authorization) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    res.status(401).json({ error: 'Token missing' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as UserPayload;

    req.user = decoded;

    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Token expired' });
      return;
    } else {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
  }
};

export const generateToken = (username: string, domain: string, password: string): string => {
  const payload: UserPayload = { username, domain, password };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
  return token;
};
