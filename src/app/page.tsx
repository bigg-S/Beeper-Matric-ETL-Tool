'use client'

import { useApp } from './providers'
import { AuthForm } from '../components/auth-form'
import { SyncStatus } from '../components/sync-status'
import { Dashboard } from '../components/dashboard'

export default function Home() {
    const { auth } = useApp()

    return (
        <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="container mx-auto px-4 py-8">
            {!auth.isAuthenticated ? (
            <div className="flex items-center justify-center min-h-[80vh]">
                <AuthForm />
            </div>
            ) : (
            <div className="space-y-6">
                <Dashboard />
                <SyncStatus />
            </div>
            )}
        </div>
        </main>
    )
}
