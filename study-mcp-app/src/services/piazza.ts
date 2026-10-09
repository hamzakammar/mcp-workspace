import { apiClient } from '../config/api';

export interface PiazzaStatus {
  connected: boolean;
  syncing: boolean;
  lastSync?: string;
  classesCount?: number;
}

export class PiazzaService {
  /**
   * Check if backend is reachable
   */
  private async checkBackendHealth(): Promise<boolean> {
    try {
      const response = await fetch('https://horizon.hamzaammar.ca/health');
      return response.ok;
    } catch (error) {
      console.error('[Piazza] Backend health check failed:', error);
      return false;
    }
  }

  /**
   * Get Piazza connection status
   */
  async getStatus(): Promise<PiazzaStatus> {
    try {
      const response = await apiClient.get<any>('/piazza/status');
      return {
        connected: response.data.connected || false,
        syncing: false,
        lastSync: response.data.lastSync || undefined,
        classesCount: response.data.classesCount || 0,
      };
    } catch (error: any) {
      console.error('Error getting Piazza status:', error);
      return {
        connected: false,
        syncing: false,
        classesCount: 0,
      };
    }
  }

  /**
   * Connect to Piazza (store credentials)
   */
  async connect(credentials: { email: string; password: string }): Promise<void> {
    try {
      if (__DEV__) console.log('[Piazza] Attempting to connect...');

      const isHealthy = await this.checkBackendHealth();
      if (!isHealthy) {
        throw new Error('Cannot reach backend server. Please make sure the backend is running.');
      }

      await apiClient.post('/piazza/connect', credentials);
      if (__DEV__) console.log('[Piazza] Connection successful');
    } catch (error: any) {
      console.error('[Piazza] Connection error:', error);
      throw error;
    }
  }

  /**
   * Connect to Piazza using cookies (from WebView capture)
   */
  async connectWithCookies(payload: { cookies: string }): Promise<void> {
    try {
      if (__DEV__) console.log('[Piazza] Storing cookies...');

      const isHealthy = await this.checkBackendHealth();
      if (!isHealthy) {
        throw new Error('Cannot reach backend server. Please make sure the backend is running.');
      }

      await apiClient.post('/piazza/connect-cookie', payload);
      if (__DEV__) console.log('[Piazza] Cookies stored successfully');
    } catch (error: any) {
      console.error('[Piazza] Cookie storage error:', error);
      throw error;
    }
  }

  /**
   * Sync all Piazza data
   */
  async syncAll(): Promise<void> {
    try {
      await apiClient.post('/piazza/sync');
    } catch (error: any) {
      console.error('[Piazza] Sync error:', error);
      throw error;
    }
  }

  /**
   * Embed missing Piazza posts
   */
  async embedMissing(): Promise<void> {
    await apiClient.post('/piazza/embed-missing');
  }

  /**
   * Get stored Piazza posts from DB (feed)
   */
  async getPosts(courseId?: string, limit?: number): Promise<any[]> {
    const params: any = {};
    if (courseId) params.courseId = courseId;
    if (limit) params.limit = limit;
    const response = await apiClient.get('/piazza/posts', { params });
    return response.data.posts || [];
  }

  /**
   * Search Piazza posts
   */
  async search(query: string, courseId?: string): Promise<any[]> {
    const response = await apiClient.get('/piazza/search', {
      params: { q: query, courseId },
    });
    return response.data.hits || [];
  }

  /**
   * Disconnect Piazza (remove credentials)
   */
  async disconnect(): Promise<void> {
    try {
      await apiClient.delete('/piazza/disconnect');
    } catch (error: any) {
      const errorMessage = error.data?.error || error.message || 'Failed to disconnect Piazza';
      throw new Error(errorMessage);
    }
  }
}

export const piazzaService = new PiazzaService();
