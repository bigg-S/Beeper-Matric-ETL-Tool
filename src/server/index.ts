import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import routes from './api/routes';
import { initializeDatabase } from './db/client';

config();

const app = express();

const allowedOrigins = [
    process.env.CLIENT_URL,
    'http://localhost:3000',
    'http://192.168.125.79:3000'
];

const corsOptions: cors.CorsOptions = {
    origin: function (
        origin: string | undefined,
        callback: (error: Error | null, allow?: boolean) => void
    ) {
        if (!origin) return callback(null, true);

        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('Origin not allowed by CORS:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
        'Origin',
        'X-Requested-With',
        'Content-Type',
        'Accept',
        'Authorization',
    ],
    credentials: true,
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

app.options('*', cors(corsOptions));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization'
    );
    next();
});

app.use(express.json());
app.use('/api', routes);

async function start() {
    try {
        await initializeDatabase();
        app.listen(3001, () => {
        console.log(`Server running on port 3001`);
        console.log('Allowed origins:', allowedOrigins);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

start();
