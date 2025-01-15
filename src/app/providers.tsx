'use client'

import { NextUIProvider } from '@nextui-org/react'
import { createContext, useContext, useState } from 'react'

type AuthState = {
    isAuthenticated: boolean
    matrixUsername: string | null
    matrixDomain: string | null
}

type SyncState = {
    status: 'idle' | 'syncing' | 'error' | 'completed'
    progress: number
    currentOperation: string
    error?: string
}

type AppContextType = {
    auth: AuthState
    setAuth: (auth: AuthState) => void
    syncState: SyncState
    setSyncState: (state: SyncState) => void
}

const AppContext = createContext<AppContextType | undefined>(undefined)

export function Providers({ children }: { children: React.ReactNode }) {
    const [auth, setAuth] = useState<AuthState>({
        isAuthenticated: false,
        matrixUsername: null,
        matrixDomain: null,
    })

    const [syncState, setSyncState] = useState<SyncState>({
        status: 'idle',
        progress: 0,
        currentOperation: 'Waiting to start...',
    })

    return (
        <AppContext.Provider value={{ auth, setAuth, syncState, setSyncState }}>
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
