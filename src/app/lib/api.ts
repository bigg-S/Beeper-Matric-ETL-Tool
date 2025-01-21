import { LoginResponse } from './../types/index';
import { MatrixConfig } from "../types";

const API_BASE = process.env.API_URL || 'http://localhost:3001';

class APIClient {
  static getCryptoStatus() {
    throw new Error('Method not implemented.');
  }
  private static async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'API request failed');
    }

    return response.json();
  }

  static async login(config: MatrixConfig): Promise<LoginResponse> {
    const response =  await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(config),
    }) as LoginResponse;

    return response;
  }

  static async logout(): Promise<{ success: boolean }> {
    return this.request('/api/auth/logout', {
      method: 'GET',
    });
  }

  static async get_user(): Promise<{ success: boolean }> {
    return this.request('/api/auth/me', {
      method: 'GET',
    });
  }

}

export default APIClient;
