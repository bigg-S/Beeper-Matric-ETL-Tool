export interface UserPayload {
    username: string;
    password: string;
    domain: string;
}

declare global {
    namespace Express {
        interface Request {
            user?: UserPayload;
        }
    }
}
