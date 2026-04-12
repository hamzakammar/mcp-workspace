import { apiClient } from '../config/api';

export interface OutlineStatus {
  connected: boolean;
  duoRequired: boolean;
  lastUpdated?: string;
}

export class OutlineService {
  async getStatus(): Promise<OutlineStatus> {
    try {
      const response = await apiClient.get<any>('/outline/status');
      return {
        connected: response.data.connected || false,
        duoRequired: response.data.duoRequired || false,
        lastUpdated: response.data.lastUpdated || undefined,
      };
    } catch {
      return { connected: false, duoRequired: false };
    }
  }

  async connect(): Promise<void> {
    await apiClient.post('/outline/connect', {});
  }

  async connectWithCookies(payload: { cookies: string }): Promise<void> {
    await apiClient.post('/outline/connect-cookie', payload);
  }
}

export const outlineService = new OutlineService();
