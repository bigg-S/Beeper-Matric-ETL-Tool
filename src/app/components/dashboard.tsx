'use client'

import { useEffect, useState } from 'react'
import { Card, CardBody, Table, TableHeader, TableColumn, TableBody, TableRow, TableCell, Button } from '@nextui-org/react'
import { useApp } from '../providers'
import { toast } from 'react-toastify'

type SyncStats = {
    totalRooms: number
    totalMessages: number
    totalParticipants: number
    lastSync: string
    encryptedRooms: number
}

export function Dashboard() {
    const { auth } = useApp()
    const [stats, setStats] = useState<SyncStats | null>(null)
    const [_loading, setLoading] = useState(true)

    useEffect(() => {
        const fetchStats = async () => {
        try {
            const response = await fetch('/api/stats')
            const data = await response.json()
            setStats(data)
        } catch (error) {
            console.error('Failed to fetch stats:', error)
        } finally {
            setLoading(false)
        }
        }

        fetchStats()
        const interval = setInterval(fetchStats, 30000) // Update every 30 seconds

        return () => clearInterval(interval)
    }, [])

    const logout = async () => {
        try {
            await useApp().logout()

            toast.success('Logged out successfully')
        } catch (error) {
            toast.error('Logout failed. Please try again.')
            console.error('Logout error:', error)
        }
    }

    return (
        <div className="space-y-6">
        <div className="flex justify-between items-center">
            <div>
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <p className="text-default-500">
                Connected as {auth.user?.display_name}@{auth.user?.user_id}
            </p>
            </div>
            <Button
            color="danger"
            variant="light"
            onPress={() => {
                logout();
            }}
            >
            Logout
            </Button>
        </div>

        {stats && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card>
                    <CardBody>
                    <div className="text-xl font-bold">{stats.totalRooms}</div>
                    <div className="text-default-500">Total Rooms</div>
                    </CardBody>
                </Card>
                <Card>
                    <CardBody>
                    <div className="text-xl font-bold">{stats.totalMessages}</div>
                    <div className="text-default-500">Total Messages</div>
                    </CardBody>
                </Card>
                <Card>
                    <CardBody>
                    <div className="text-xl font-bold">{stats.totalParticipants}</div>
                    <div className="text-default-500">Total Participants</div>
                    </CardBody>
                </Card>
            </div>
        )}

        <Card>
            <CardBody>
                <Table aria-label="Sync Statistics">
                    <TableHeader>
                    <TableColumn>Metric</TableColumn>
                    <TableColumn>Value</TableColumn>
                    </TableHeader>
                    <TableBody>
                    {stats ? (
                        <>
                        <TableRow>
                            <TableCell>Encrypted Rooms</TableCell>
                            <TableCell>{stats.encryptedRooms}</TableCell>
                        </TableRow>
                        <TableRow>
                            <TableCell>Last Sync</TableCell>
                            <TableCell>{new Date(stats.lastSync).toLocaleString()}</TableCell>
                        </TableRow>
                        </>
                    ) : (
                        <TableRow>
                        <TableCell>Loading...</TableCell>
                        <TableCell>-</TableCell>
                        </TableRow>
                    )}
                    </TableBody>
                </Table>
            </CardBody>
        </Card>
        </div>
    )
}
