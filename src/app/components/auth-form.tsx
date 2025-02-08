'use_client'
import React, { useState } from 'react';
import { Card, CardHeader, CardBody, Input, Button, Progress } from '@nextui-org/react';
import { AuthCredentials } from '../types';
import APIClient from '../lib/api';
import { toast } from 'react-toastify';
import { useApp } from '../providers';

const AuthForm = () => {
  const { setAuth } = useApp();
  const [formState, setFormState] = useState<{
    credentials: AuthCredentials;
    status: 'idle' | 'authenticating' | 'loading-keys' | 'syncing' | 'error' | 'success';
    error: string | null;
  }>({
    credentials: {
      username: '',
      password: '',
      domain: 'matrix.beeper.com',
    },
    status: 'idle',
    error: null,
  });

  const validateForm = () => {
    if (!formState.credentials.username) return 'Username is required';
    if (!formState.credentials.password) return 'Password is required';
    if (!formState.credentials.domain) return 'Domain is required';

    try {
      new URL(`https://${formState.credentials.domain}`);
    } catch {
      return 'Please enter a valid domain';
    }

    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validateForm();
    if (validationError) {
      toast.error(validationError);
      return;
    }

    try {
      setFormState(prev => ({
        ...prev,
        status: 'authenticating',
        error: null
      }));

      const authResponse = await APIClient.login({
        username: formState.credentials.username,
        password: formState.credentials.password,
        domain: `https://${formState.credentials.domain}`,
      });

      if (!authResponse.success) {
        throw new Error(authResponse.error || 'Authentication failed');
      }

      setAuth({
        isAuthenticated: true,
        token: authResponse.token
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'An unexpected error occurred'
      );
      setFormState(prev => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Authentication failed'
      }));
    }
  };

  return (
    <Card className="max-w-md w-full">
      <CardHeader className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold">Matrix ETL Pipeline</h1>
        <p className="text-default-500">Connect your Matrix account to start syncing</p>
      </CardHeader>
      <CardBody>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            label="Matrix Client Username"
            placeholder="Enter your Matrix Client Username"
            value={formState.credentials.username}
            onChange={(e) =>
              setFormState((prev) => ({
                ...prev,
                credentials: { ...prev.credentials, username: e.target.value },
              }))
            }
            isRequired
            isDisabled={formState.status !== 'idle' && formState.status !== 'error'}
          />
          <Input
            label="Matrix Client Password"
            type="password"
            placeholder="Enter your password"
            value={formState.credentials.password}
            onChange={(e) =>
              setFormState((prev) => ({
                ...prev,
                credentials: { ...prev.credentials, password: e.target.value },
              }))
            }
            isRequired
            isDisabled={formState.status !== 'idle' && formState.status !== 'error'}
          />
          <Input
            label="Matrix Client Domain"
            placeholder="beeper.com"
            value={formState.credentials.domain}
            onChange={(e) =>
              setFormState((prev) => ({
                ...prev,
                credentials: { ...prev.credentials, domain: e.target.value },
              }))
            }
            isRequired
            isDisabled={formState.status !== 'idle' && formState.status !== 'error'}
          />

          {formState.error && (
            <div className="text-danger text-sm p-2 bg-danger-50 rounded-lg">{formState.error}</div>
          )}

          {formState.status !== 'idle' && formState.status !== 'error' && (
            <div className="flex flex-col gap-2">
              <Progress size="sm" isIndeterminate aria-label="Loading..." className="max-w-md" />
            </div>
          )}

          <Button
            color="primary"
            type="submit"
            isDisabled={formState.status !== 'idle' && formState.status !== 'error'}
            isLoading={formState.status !== 'idle' && formState.status !== 'error'}
          >
            {formState.status === 'idle' || formState.status === 'error'
              ? 'Connect'
              : 'Connecting...'}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
};

export default AuthForm;
