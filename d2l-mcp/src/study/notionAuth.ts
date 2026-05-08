/**
 * Notion credential helpers — read/write the access token from user_credentials.
 */

import { supabase } from '../utils/supabase.js';

/**
 * Retrieve the stored Notion access token for a user.
 * Returns null if not connected.
 */
export async function getNotionToken(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('user_credentials')
      .select('token')
      .eq('user_id', userId)
      .eq('service', 'notion')
      .single();
    if (error || !data?.token) return null;
    return data.token as string;
  } catch {
    return null;
  }
}

/**
 * Store a Notion access token for a user.
 */
export async function saveNotionToken(userId: string, accessToken: string): Promise<void> {
  const { error } = await supabase
    .from('user_credentials')
    .upsert(
      { user_id: userId, service: 'notion', token: accessToken, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,service' },
    );
  if (error) throw new Error(`Failed to save Notion token: ${error.message}`);
}
