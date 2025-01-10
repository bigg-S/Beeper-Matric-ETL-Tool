'use client';

import { useState } from 'react';
import { AuthForm } from '../components/auth-form';
import { Dashboard } from '../components/dashboard';

export default function Home() {
const [isAuthenticated, setIsAuthenticated] = useState(false);

return (
    <main className="container mx-auto p-4">
    {!isAuthenticated ? (
        <AuthForm onSuccess={() => setIsAuthenticated(true)} />
    ) : (
        <Dashboard />
    )}
    </main>
);
}
