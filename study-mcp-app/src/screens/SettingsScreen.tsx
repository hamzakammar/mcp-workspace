import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { AntDesign } from '@expo/vector-icons';
import CookieManager from '@react-native-cookies/cookies';
import { useAuth } from '../context/AuthContext';
import { d2lService } from '../services/d2l';
import { piazzaService } from '../services/piazza';
import { notesService } from '../services/notes';

interface IntegrationStatus {
  connected: boolean;
  syncing: boolean;
  lastSync?: string;
  classesCount?: number;
}

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const navigation = useNavigation();
  const [d2lStatus, setD2lStatus] = useState<IntegrationStatus>({
    connected: false,
    syncing: false,
  });
  const [piazzaStatus, setPiazzaStatus] = useState<IntegrationStatus>({
    connected: false,
    syncing: false,
  });

  useEffect(() => {
    loadIntegrationStatus();
  }, []);

  // Reload status when screen comes into focus (e.g., after connecting)
  useFocusEffect(
    React.useCallback(() => {
      // Small delay to ensure backend has processed the connection
      const timer = setTimeout(() => {
        loadIntegrationStatus();
      }, 500);
      return () => clearTimeout(timer);
    }, [])
  );

  const loadIntegrationStatus = async () => {
    try {
      const [d2l, piazza] = await Promise.all([
        d2lService.getStatus(),
        piazzaService.getStatus(),
      ]);
      setD2lStatus(d2l);
      setPiazzaStatus(piazza);
    } catch (error) {
      console.error('Error loading integration status:', error);
    }
  };

  const handleD2LConnect = async () => {
    // @ts-ignore - navigation type will be fixed later
    navigation.navigate('D2LConnect');
  };

  const handleD2LSync = async () => {
    setD2lStatus((prev) => ({ ...prev, syncing: true }));
    try {
      await d2lService.syncAll();
      Alert.alert('Success', 'D2L data synced successfully');
      await loadIntegrationStatus();
    } catch (error: any) {
      Alert.alert('Sync Failed', error.message || 'Failed to sync D2L data');
    } finally {
      setD2lStatus((prev) => ({ ...prev, syncing: false }));
    }
  };

  const handlePiazzaConnect = async () => {
    // @ts-ignore - navigation type will be fixed later
    navigation.navigate('PiazzaConnect');
  };

  const handlePiazzaSync = async () => {
    setPiazzaStatus((prev) => ({ ...prev, syncing: true }));
    try {
      await piazzaService.syncAll();
      Alert.alert('Success', 'Piazza data synced successfully');
      await loadIntegrationStatus();
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to sync Piazza data';
      
      // Check if re-authentication is required
      if (errorMessage.includes('authentication') || errorMessage.includes('reconnect') || errorMessage.includes('re-authenticate')) {
        Alert.alert(
          'Authentication Required',
          'Your Piazza session has expired. Please reconnect to continue syncing.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Reconnect',
              onPress: () => handlePiazzaConnect(),
            },
          ]
        );
      } else {
        Alert.alert('Sync Failed', errorMessage);
      }
    } finally {
      setPiazzaStatus((prev) => ({ ...prev, syncing: false }));
    }
  };

  const handlePiazzaDisconnect = async () => {
    Alert.alert(
      'Disconnect Piazza',
      'Are you sure you want to disconnect your Piazza account?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            try {
              // Clear Piazza-related WebView cookies so the next login starts from a clean state
              try {
                console.log('[Piazza] Clearing WebView cookies before disconnect');
                await CookieManager.clearAll(true);
              } catch (cookieError) {
                console.warn('[Piazza] Failed to clear WebView cookies:', cookieError);
              }

              await piazzaService.disconnect();
              Alert.alert('Success', 'Piazza disconnected successfully');
              await loadIntegrationStatus();
            } catch (error: any) {
              Alert.alert('Disconnect Failed', error.message || 'Failed to disconnect Piazza');
            }
          },
        },
      ]
    );
  };

  const handleEmbedMissing = async () => {
    Alert.alert(
      'Embed Missing Notes',
      'This will generate embeddings for notes that haven\'t been embedded yet.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start',
          onPress: async () => {
            try {
              await notesService.embedMissing();
              Alert.alert('Success', 'Embedding process started');
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to start embedding');
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView style={styles.scrollView}>
        <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.userEmail}>{user?.email}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Integrations</Text>

        {/* D2L Integration */}
        <View style={styles.integrationCard}>
          <View style={styles.integrationHeader}>
            <View style={styles.integrationTitleContainer}>
              <AntDesign name="book" size={20} color="#6366f1" style={{ marginRight: 10 }} />
              <Text style={styles.integrationName}>D2L Brightspace</Text>
            </View>
            <View style={styles.statusBadge}>
              <View
                style={[
                  styles.statusDot,
                  d2lStatus.connected ? styles.statusConnected : styles.statusDisconnected,
                ]}
              />
              <Text style={styles.statusText}>
                {d2lStatus.connected ? 'Connected' : 'Not Connected'}
              </Text>
            </View>
          </View>
          <Text style={styles.integrationDescription}>
            Sync courses, assignments, grades, and content from D2L Brightspace
          </Text>
          {d2lStatus.lastSync && (
            <Text style={styles.lastSync}>Last sync: {new Date(d2lStatus.lastSync).toLocaleString()}</Text>
          )}
          <View style={styles.integrationActions}>
            {!d2lStatus.connected ? (
              <TouchableOpacity style={styles.connectButton} onPress={handleD2LConnect}>
                <AntDesign name="link" size={16} color="#fff" style={{ marginRight: 6 }} />
                <Text style={styles.connectButtonText}>Connect</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.syncButton, d2lStatus.syncing && styles.syncButtonDisabled]}
                onPress={handleD2LSync}
                disabled={d2lStatus.syncing}
              >
                {d2lStatus.syncing ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <AntDesign name="sync" size={16} color="#fff" style={{ marginRight: 6 }} />
                    <Text style={styles.syncButtonText}>Sync Now</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Piazza Integration */}
        <View style={styles.integrationCard}>
          <View style={styles.integrationHeader}>
            <View style={styles.integrationTitleContainer}>
              <AntDesign name="message" size={20} color="#6366f1" style={{ marginRight: 10 }} />
              <Text style={styles.integrationName}>Piazza</Text>
            </View>
            <View style={styles.statusBadge}>
              <View
                style={[
                  styles.statusDot,
                  piazzaStatus.connected ? styles.statusConnected : styles.statusDisconnected,
                ]}
              />
              <Text style={styles.statusText}>
                {piazzaStatus.connected ? 'Connected' : 'Not Connected'}
              </Text>
            </View>
          </View>
          <Text style={styles.integrationDescription}>
            Sync posts, discussions, and Q&A from Piazza
          </Text>
          {piazzaStatus.connected && (
            <View style={styles.statusInfo}>
              {piazzaStatus.classesCount !== undefined && piazzaStatus.classesCount > 0 && (
                <Text style={styles.statusInfoText}>
                  {piazzaStatus.classesCount} {piazzaStatus.classesCount === 1 ? 'class' : 'classes'} synced
                </Text>
              )}
              {piazzaStatus.lastSync && (
                <Text style={styles.lastSync}>Last sync: {new Date(piazzaStatus.lastSync).toLocaleString()}</Text>
              )}
            </View>
          )}
          <View style={styles.integrationActions}>
            {!piazzaStatus.connected ? (
              <TouchableOpacity style={styles.connectButton} onPress={handlePiazzaConnect}>
                <AntDesign name="link" size={16} color="#fff" style={{ marginRight: 6 }} />
                <Text style={styles.connectButtonText}>Connect</Text>
              </TouchableOpacity>
            ) : (
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <TouchableOpacity
                  style={[styles.syncButton, piazzaStatus.syncing && styles.syncButtonDisabled, { flex: 1 }]}
                  onPress={handlePiazzaSync}
                  disabled={piazzaStatus.syncing}
                >
                  {piazzaStatus.syncing ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <AntDesign name="sync" size={16} color="#fff" style={{ marginRight: 6 }} />
                      <Text style={styles.syncButtonText}>Sync Now</Text>
                    </>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.disconnectButton]}
                  onPress={handlePiazzaDisconnect}
                >
                  <AntDesign name="logout" size={16} color="#ef4444" style={{ marginRight: 6 }} />
                  <Text style={styles.disconnectButtonText}>Sign Out</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notes</Text>
        <TouchableOpacity style={styles.actionButton} onPress={handleEmbedMissing}>
          <View style={styles.actionButtonHeader}>
            <AntDesign name="file-text" size={18} color="#6366f1" style={{ marginRight: 10 }} />
            <Text style={styles.actionButtonText}>Embed Missing Notes</Text>
          </View>
          <Text style={styles.actionButtonSubtext}>
            Generate embeddings for notes that haven't been processed
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <TouchableOpacity
          style={[styles.actionButton, styles.logoutButton]}
          onPress={() => {
            Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Sign Out',
                style: 'destructive',
                onPress: logout,
              },
            ]);
          }}
        >
          <View style={styles.actionButtonHeader}>
            <AntDesign name="poweroff" size={18} color="#ef4444" style={{ marginRight: 10 }} />
            <Text style={[styles.actionButtonText, styles.logoutButtonText]}>Sign Out</Text>
          </View>
        </TouchableOpacity>
      </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  scrollView: {
    flex: 1,
  },
  header: {
    paddingTop: 8,
    paddingHorizontal: 24,
    paddingBottom: 16,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 6,
    color: '#1e293b',
  },
  userEmail: {
    fontSize: 14,
    color: '#64748b',
    fontWeight: '500',
  },
  section: {
    marginTop: 24,
    paddingHorizontal: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
    color: '#1e293b',
  },
  integrationCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  integrationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  integrationTitleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  integrationName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1e293b',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusConnected: {
    backgroundColor: '#10b981',
  },
  statusDisconnected: {
    backgroundColor: '#94a3b8',
  },
  statusText: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '600',
  },
  integrationDescription: {
    fontSize: 14,
    color: '#64748b',
    marginBottom: 10,
    lineHeight: 20,
  },
  statusInfo: {
    marginBottom: 12,
  },
  statusInfoText: {
    fontSize: 13,
    color: '#6366f1',
    fontWeight: '600',
    marginBottom: 4,
  },
  lastSync: {
    fontSize: 12,
    color: '#94a3b8',
    marginBottom: 16,
    fontWeight: '500',
  },
  integrationActions: {
    marginTop: 4,
  },
  connectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#6366f1',
    borderRadius: 12,
    padding: 14,
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  connectButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  syncButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#10b981',
    borderRadius: 12,
    padding: 14,
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  syncButtonDisabled: {
    opacity: 0.6,
  },
  syncButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  disconnectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1.5,
    borderColor: '#ef4444',
  },
  disconnectButtonText: {
    color: '#ef4444',
    fontWeight: '600',
    fontSize: 15,
  },
  actionButton: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  actionButtonHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  actionButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
  },
  actionButtonSubtext: {
    fontSize: 14,
    color: '#64748b',
    lineHeight: 20,
  },
  logoutButton: {
    backgroundColor: '#ffffff',
    borderWidth: 1.5,
    borderColor: '#fee2e2',
  },
  logoutButtonText: {
    color: '#ef4444',
  },
});
