import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation } from '@react-navigation/native';
import { AntDesign } from '@expo/vector-icons';
import Pdf from 'react-native-pdf';
import { apiClient, BASE_URL } from '../config/api';
import { supabase } from '../lib/supabase';

const { width } = Dimensions.get('window');

interface RouteParams {
  title: string;
  courseId: string;
  fileUrl: string;
}

export default function PDFViewerScreen() {
  const route = useRoute();
  const navigation = useNavigation<any>();
  const { title, courseId, fileUrl } = (route.params as RouteParams);

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [authHeader, setAuthHeader] = useState<string>('');

  // Get auth token for PDF header. getSession() refreshes an expired access
  // token, so calling this again on Retry recovers from a stale header.
  const loadAuthHeader = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        setAuthHeader(`Bearer ${session.access_token}`);
      } else {
        setError('Not signed in. Please log in again.');
      }
    } catch (e: any) {
      setError(e?.message || 'Could not get auth session');
    }
  }, []);

  useEffect(() => {
    loadAuthHeader();
  }, [loadAuthHeader]);

  const handleRetry = () => {
    setError(null);
    setLoading(true);
    setAuthHeader('');
    loadAuthHeader();
  };

  const proxyUrl = `${BASE_URL}/d2l/courses/${courseId}/file?url=${encodeURIComponent(fileUrl)}`;

  const handleSaveToNotes = async () => {
    if (saved) return;
    Alert.alert(
      'Save to Notes',
      `Save "${title}" to your notes? It will be processed and searchable.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: async () => {
            setSaving(true);
            try {
              const res = await apiClient.post<{ chunkCount: number }>(
                `/d2l/courses/${courseId}/file/save`,
                { fileUrl, title }
              );
              setSaved(true);
              Alert.alert('Saved!', `"${title}" saved to Notes — ${res.data.chunkCount} chunks processed.`);
            } catch (e: any) {
              Alert.alert('Error', e.message || 'Failed to save');
            } finally {
              setSaving(false);
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerButton} onPress={() => navigation.goBack()}>
          <AntDesign name="arrowleft" size={22} color="#1e293b" />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <TouchableOpacity
          style={[styles.saveButton, saved && styles.saveButtonDone, saving && styles.saveButtonLoading]}
          onPress={handleSaveToNotes}
          disabled={saving || saved}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <AntDesign name={saved ? 'check' : 'download'} size={16} color="#fff" />
          )}
          <Text style={styles.saveButtonText}>{saved ? 'Saved' : 'Save'}</Text>
        </TouchableOpacity>
      </View>

      {/* Page indicator */}
      {totalPages > 0 && (
        <View style={styles.pageBar}>
          <Text style={styles.pageText}>{page} / {totalPages}</Text>
        </View>
      )}

      {/* PDF Viewer */}
      {error ? (
        <View style={styles.errorContainer}>
          <AntDesign name="warning" size={48} color="#f59e0b" />
          <Text style={styles.errorTitle}>Failed to load PDF</Text>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        // Only render PDF once we have the auth header
        authHeader ? (
          <Pdf
            source={{
              uri: proxyUrl,
              headers: { Authorization: authHeader },
              cache: true,
            }}
            style={styles.pdf}
            onLoadComplete={(pages) => { setTotalPages(pages); setLoading(false); }}
            onPageChanged={(p) => setPage(p)}
            onError={(err) => {
              console.error('[PDF] Error:', err);
              setError(typeof err === 'string' ? err : 'Could not load this PDF');
              setLoading(false);
            }}
            enablePaging={false}
            horizontal={false}
            fitPolicy={0}
            trustAllCerts={false}
            renderActivityIndicator={() => (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#6366f1" />
                <Text style={styles.loadingText}>Loading PDF...</Text>
              </View>
            )}
          />
        ) : (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#6366f1" />
          </View>
        )
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', gap: 8,
  },
  headerButton: {
    width: 36, height: 36, justifyContent: 'center', alignItems: 'center',
    borderRadius: 8, backgroundColor: '#f1f5f9',
  },
  title: { flex: 1, fontSize: 15, fontWeight: '600', color: '#1e293b' },
  saveButton: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#6366f1', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
  },
  saveButtonDone: { backgroundColor: '#10b981' },
  saveButtonLoading: { backgroundColor: '#94a3b8' },
  saveButtonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  pageBar: {
    backgroundColor: 'rgba(0,0,0,0.6)', alignSelf: 'center',
    paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, marginVertical: 4,
    position: 'absolute', bottom: 24, zIndex: 10,
  },
  pageText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  pdf: { flex: 1, width, backgroundColor: '#1a1a2e' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 12, fontSize: 15, color: '#6366f1' },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, backgroundColor: '#fff' },
  errorTitle: { fontSize: 18, fontWeight: '700', color: '#1e293b', marginTop: 16 },
  errorText: { fontSize: 14, color: '#64748b', textAlign: 'center', marginTop: 8, marginBottom: 20 },
  retryButton: { backgroundColor: '#6366f1', paddingVertical: 12, paddingHorizontal: 28, borderRadius: 8 },
  retryText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
