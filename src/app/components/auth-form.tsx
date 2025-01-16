'use client'

import { useState } from 'react'
import { Card, CardHeader, CardBody, Input, Button } from '@nextui-org/react'
import { useApp } from '../providers'
import { LoginCredentials } from '../types'
import APIClient from '../lib/api'

export function AuthForm() {
    const { setAuth } = useApp()
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [formData, setFormData] = useState<LoginCredentials>({
        username: '',
        password: '',
        domain: 'beeper.com'
    })

    const validateDomain = (domain: string): boolean => {
        try {
            new URL(`https://${domain}`)
            return true
        } catch {
            return false
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)

        if (!validateDomain(formData.domain)) {
            setError('Please enter a valid domain')
            setLoading(false)
            return
        }

        try {
            const response = await APIClient.login({
                username: formData.username,
                password: formData.password,
                domain: `https://${formData.domain}`
            })

            if (response.data.success) {
                setAuth({
                    isAuthenticated: true,
                    token: response.data.token,
                })

                try {
                    const userData = await APIClient.get_user()
                    console.log("User data: ", userData)
                    // Handle user data as needed
                } catch (userError) {
                    console.error('Error fetching user data:', userError)
                }
            }
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
                        isInvalid={Boolean(error)}
                    />
                    <Input
                        label="Password"
                        type="password"
                        placeholder="Enter your password"
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        isRequired
                        isInvalid={Boolean(error)}
                    />
                    <Input
                        label="Matrix Domain"
                        placeholder="beeper.com"
                        value={formData.domain}
                        onChange={(e) => setFormData({ ...formData, domain: e.target.value })}
                        isRequired
                        isInvalid={Boolean(error)}
                    />
                    {error && (
                        <div className="text-danger text-sm p-2 bg-danger-50 rounded-lg">
                            {error}
                        </div>
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
