export interface UserProfile {
  user_id: string;
  display_name?: string;
  avatar_url?: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  token: string | null;
  user: UserProfile | null;
}

export interface AuthCredentials {
  username: string;
  password: string;
  domain: string;
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  error?: string;
}

export interface MatrixConfig {
  username: string;
  password: string;
  domain: string;
}

export interface AuthResponse {
  success: boolean;
  token?: string;
}
