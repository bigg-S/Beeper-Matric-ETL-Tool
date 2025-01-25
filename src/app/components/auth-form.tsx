import React, { useState } from 'react';
import { Card, CardHeader, CardBody, Input, Button, Progress } from '@nextui-org/react';
import { AuthCredentials } from '../types';
import APIClient from '../lib/api';

const AuthForm = () => {
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
      setFormState((prev) => ({ ...prev, error: validationError }));
      return;
    }

    try {
      setFormState((prev) => ({ ...prev, status: 'authenticating', error: null }));

      const authResponse = await APIClient.login({
        username: formState.credentials.username,
        password: formState.credentials.password,
        domain: `https://${formState.credentials.domain}`,
      });

      console.log(authResponse);

      if (!authResponse.success) {
        throw new Error('Authentication failed');
      }

      setFormState((prev) => ({ ...prev, status: 'loading-keys' }));

      // Poll for crypto initialization status
      // const checkCryptoStatus = async () => {
      //   try {
      //     const status = APIClient.getCryptoStatus();
      //     if (status.) {
      //       setFormState(prev => ({ ...prev, status: 'syncing' }));
      //       const userData = await APIClient.get_user();
      //       if (userData.success) {
      //         setFormState(prev => ({ ...prev, status: 'success' }));
      //       }
      //     } else {
      //       setTimeout(checkCryptoStatus, 1000);
      //     }
      //   } catch (error) {
      //     setFormState(prev => ({
      //       ...prev,
      //       status: 'error',
      //       error: 'Failed to initialize E2E encryption'
      //     }));
      //   }
      // };

      // checkCryptoStatus();
    } catch (error) {
      setFormState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Authentication failed',
      }));
    }
  };

  const getStatusMessage = () => {
    switch (formState.status) {
      case 'authenticating':
        return 'Authenticating...';
      case 'loading-keys':
        return 'Loading E2E encryption keys...';
      case 'syncing':
        return 'Syncing with Matrix server...';
      case 'success':
        return 'Successfully connected!';
      default:
        return null;
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
              <p className="text-small text-default-500 text-center">{getStatusMessage()}</p>
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
