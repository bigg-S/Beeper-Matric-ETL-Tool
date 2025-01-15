
'use client'

import { createContext, useContext, useState, useEffect } from 'react'
import { NextUIProvider } from '@nextui-org/react'
import { AuthState, UserProfile } from './types'

type SyncState = {
    status: 'syncing' | 'synced' | 'failed';
    progress: number;
    currentOperation: string;
    error?: string;
}

interface AppContextType {
    auth: AuthState;
    setAuth: (auth: Partial<AuthState>) => void;
    logout: () => Promise<void>;
    syncState: SyncState;
    setSyncState: (state: SyncState) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined)

const INITIAL_AUTH_STATE: AuthState = {
    isAuthenticated: false,
    token: null,
    user: null,
}

const INITIAL_SYNC_STATE: SyncState = {
    status: 'synced',
    progress: 0,
    currentOperation: 'Waiting to start...',
}

export function Providers({ children }: { children: React.ReactNode }) {
    const [auth, setAuthState] = useState<AuthState>(() => {
        // Check for existing token in localStorage on initialization
        if (typeof window !== 'undefined') {
        const token = localStorage.getItem('auth_token')
        if (token) {
            return {
            ...INITIAL_AUTH_STATE,
            isAuthenticated: true,
            token,
            }
        }
        }
        return INITIAL_AUTH_STATE
    })

    const [syncState, setSyncState] = useState<SyncState>(INITIAL_SYNC_STATE)

    useEffect(() => {
        // Fetch user profile if authenticated
        const fetchUserProfile = async () => {
        if (auth.isAuthenticated && auth.token && !auth.user) {
            try {
            const response = await fetch('/api/auth/me', {
                headers: {
                'Authorization': `Bearer ${auth.token}`
                }
            })

            if (response.ok) {
                const userData: UserProfile = await response.json()
                setAuthState(prev => ({
                ...prev,
                user: userData
                }))
            } else {
                // If profile fetch fails, log out
                handleLogout()
            }
            } catch (error) {
            console.error('Failed to fetch user profile:', error)
            handleLogout()
            }
        }
        }

        fetchUserProfile()
    }, [auth.isAuthenticated, auth.token])

    const setAuth = (newAuth: Partial<AuthState>) => {
        setAuthState(prev => {
        const updated = { ...prev, ...newAuth }
        if (updated.token) {
            localStorage.setItem('auth_token', updated.token)
        }
        return updated
        })
    }

    const handleLogout = async () => {
        try {
        if (auth.token) {
            await fetch('/api/auth/logout', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${auth.token}`
            }
            })
        }
        } catch (error) {
        console.error('Logout error:', error)
        } finally {
        localStorage.removeItem('auth_token')
            setAuthState(INITIAL_AUTH_STATE)
            setSyncState(INITIAL_SYNC_STATE)
        }
    }

    return (
        <AppContext.Provider value={{ auth, setAuth, logout: handleLogout, syncState, setSyncState }}>
            <NextUIProvider>{children}</NextUIProvider>
        </AppContext.Provider>
    )
}

export function useApp() {
    const context = useContext(AppContext)
    if (context === undefined) {
        throw new Error('useApp must be used within a AppProvider')
    }
    return context
}
