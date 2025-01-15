'use client'

import { useEffect } from 'react'
import { Card, CardBody, Progress, Button } from '@nextui-org/react'
import { useApp } from '../app/providers'

export function SyncStatus() {
    const { syncState, setSyncState } = useApp()

    useEffect(() => {
        let ws: WebSocket

        const connectWebSocket = () => {
        ws = new WebSocket('ws://localhost:3000/api/sync')

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data)
            setSyncState({
            status: data.status,
            progress: data.progress,
            currentOperation: data.currentOperation,
            error: data.error,
            })
        }

        ws.onclose = () => {
            // Attempt to reconnect after 5 seconds
            setTimeout(connectWebSocket, 5000)
        }
        }

        connectWebSocket()

        return () => {
        if (ws) {
            ws.close()
        }
        }
    }, [setSyncState])

    const getStatusColor = () => {
        switch (syncState.status) {
        case 'completed':
            return 'success'
        case 'error':
            return 'danger'
        case 'syncing':
            return 'primary'
        default:
            return 'default'
        }
    }

    const handleRetry = async () => {
        try {
        await fetch('/api/sync/retry', { method: 'POST' })
        } catch (error) {
        console.error('Failed to retry sync:', error)
        }
    }

    return (
        <Card className="w-full">
            <CardBody className="flex flex-col gap-4">
                <div className="flex justify-between items-center">
                <h2 className="text-xl font-semibold">Sync Status</h2>
                {syncState.status === 'error' && (
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
