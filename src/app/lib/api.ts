'use_client'
import { AuthResponse, UserProfile } from '../types';
import { MatrixConfig } from '../types';

class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

class APIError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'APIError';
    this.statusCode = statusCode;
  }
}

type CryptoStatus = {
  initialized: boolean;
  keyCount: number;
  lastUpdated: string;
}

const API_BASE = process.env.API_URL || 'http://localhost:3001';

class APIClient {
  private static async request<T>(
    endpoint: string,
    options: RequestInit = {},
    requireAuth = true
  ): Promise<T> {
    const token = localStorage.getItem('auth_token');

    if (requireAuth && !token) {
      throw new AuthenticationError('No authentication token');
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` }),
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new APIError(
        errorData.message || 'Request failed',
        response.status
      );
    }

    return response.json();
  }

  static async getCryptoStatus(): Promise<CryptoStatus> {
    return this.request('/api/crypto/status');
  }

  static async login(config: MatrixConfig): Promise<AuthResponse> {
    const response = await this.request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(config),
    }, false);
    return response;
  }

  static async logout(): Promise<{ success: boolean }> {
    return this.request('/api/auth/logout', { method: 'GET' });
  }

  static async get_user(): Promise<UserProfile> {
    return this.request('/api/auth/me', { method: 'GET' });
  }
}

export default APIClient;
