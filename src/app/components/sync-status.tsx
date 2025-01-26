'use client'

import { useEffect } from 'react'
import { Card, CardBody, Progress, Button } from '@nextui-org/react'
import { useApp } from '../providers'

export function SyncStatus() {
    const { syncState, setSyncState, auth } = useApp()

    useEffect(() => {
        if (!auth.isAuthenticated || !auth.token) {
            return;
        }

        let ws: WebSocket
        let reconnectTimeout: NodeJS.Timeout

        const connectWebSocket = () => {
        // include token in WebSocket URL for authentication
        ws = new WebSocket(`ws://localhost:3000/api/sync?token=${auth.token}`)

        ws.onopen = () => {
            console.log('WebSocket connected')
        }

        ws.onmessage = (event) => {
            try {
            const data = JSON.parse(event.data)
            setSyncState({
                status: data.status,
                progress: data.progress,
                currentOperation: data.currentOperation,
                error: data.error,
            })
            } catch (error) {
                console.error('Failed to parse WebSocket message:', error)
            }
        }

        ws.onclose = (event) => {
            console.log('WebSocket disconnected:', event.code, event.reason)
            // only attempt to reconnect if we're still authenticated
            if (auth.isAuthenticated) {
                reconnectTimeout = setTimeout(connectWebSocket, 5000)
            }
        }

        ws.onerror = (error) => {
            console.error('WebSocket error:', error)
        }
        }

        connectWebSocket()

        return () => {
            if (ws) {
                ws.close()
            }
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout)
            }
        }
    }, [auth.isAuthenticated, auth.token, setSyncState])

    const getStatusColor = () => {
        switch (syncState.status) {
        case 'synced':
            return 'success'
        case 'failed':
            return 'danger'
        case 'syncing':
            return 'primary'
        default:
            return 'default'
        }
    }

    const handleRetry = async () => {
        if (!auth.token) return;

        try {
        const response = await fetch('/api/sync/retry', {
                method: 'POST',
                headers: {
                'Authorization': `Bearer ${auth.token}`
            }
        })

        if (!response.ok) {
            throw new Error('Failed to retry sync')
        }
        } catch (error) {
            console.error('Failed to retry sync:', error)
        }
    }

    if (!auth.isAuthenticated) {
        return null;
    }

    return (
        <Card className="w-full">
        <CardBody className="flex flex-col gap-4">
            <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold">Sync Status</h2>
            {syncState.status === 'failed' && (
                <Button
                color="primary"
                size="sm"
                onClick={handleRetry}
                >
                Retry Sync
                </Button>
            )}
            </div>

            <div className="space-y-2">
            <div className="flex justify-between">
                <span className="text-default-600">Status:</span>
                <span className={`text-${getStatusColor()}`}>
                {syncState.status.charAt(0).toUpperCase() + syncState.status.slice(1)}
                </span>
            </div>

            <div className="space-y-1">
                <span className="text-sm text-default-600">Progress</span>
                <Progress
                value={syncState.progress}
                color={getStatusColor()}
                className="w-full"
                />
            </div>

            <div className="text-sm text-default-500">
                {syncState.currentOperation}
            </div>

            {syncState.error && (
                <div className="mt-4 p-3 bg-danger-50 text-danger rounded-lg">
                {syncState.error}
                </div>
            )}
            </div>
        </CardBody>
        </Card>
    )
}
