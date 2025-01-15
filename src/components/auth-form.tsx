'use client'

import { useState } from 'react'
import { Card, CardHeader, CardBody, Input, Button } from '@nextui-org/react'
import { useApp } from '../app/providers'

export function AuthForm() {
    const { setAuth } = useApp()
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [formData, setFormData] = useState({
        username: '',
        password: '',
        domain: 'beeper.com'
    })

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)

        try {
        const response = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
            username: formData.username,
            password: formData.password,
            domain: formData.domain,
            }),
        })

        if (!response.ok) {
            const data = await response.json()
            throw new Error(data.message || 'Authentication failed')
        }

        setAuth({
            isAuthenticated: true,
            matrixUsername: formData.username,
            matrixDomain: formData.domain,
        })
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Authentication failed')
        } finally {
            setLoading(false)
        }
    }

    return (
        <Card className="max-w-md w-full">
            <CardHeader className="flex flex-col gap-3">
                <h1 className="text-2xl font-bold">Matrix ETL Pipeline</h1>
                <p className="text-default-500">Login with your Matrix credentials</p>
            </CardHeader>
            <CardBody>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <Input
                        label="Matrix Username"
                        placeholder="@username"
                        value={formData.username}
                        onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                        isRequired
                    />
                    <Input
                        label="Password"
                        type="password"
                        placeholder="Enter your password"
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        isRequired
                    />
                    <Input
                        label="Matrix Domain"
                        placeholder="beeper.com"
                        value={formData.domain}
                        onChange={(e) => setFormData({ ...formData, domain: e.target.value })}
                        isRequired
                    />
                    {error && (
                        <div className="text-danger text-sm">{error}</div>
                    )}
                    <Button
                        color="primary"
                        type="submit"
                        isLoading={loading}
                        className="mt-2"
                    >
                        {loading ? 'Authenticating...' : 'Login'}
                    </Button>
                </form>
            </CardBody>
        </Card>
    )
}
