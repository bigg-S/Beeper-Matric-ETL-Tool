import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import routes from './api/routes';
import { initializeDatabase } from './db/client';

config();

const app = express();
const port = process.env.SERVER_PORT || 3001;

app.use(cors());
app.use(express.json());
app.use('/api', routes);

async function start() {
    try {
        await initializeDatabase();
        app.listen(port, () => {
        console.log(`Server running on port ${port}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

start();
