import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

export function authMiddleware(req: any, res: any, next: any) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h as string);
  if (!m) return res.status(401).json({ error: 'missing token' });
  try {
    const payload: any = jwt.verify(m[1], JWT_SECRET);
    req.user_id = payload.id;
    // Backwards compatible: still expose role if present, but prefer is_admin flag
    req.role = payload.role;
    req.is_admin = !!payload.is_admin;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}
