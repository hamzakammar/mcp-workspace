import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useNavigation } from '@react-navigation/native';
import { AntDesign } from '@expo/vector-icons';
import CookieManager from '@react-native-cookies/cookies';
import { outlineService } from '../../services/outline';

export default function OutlineWebViewScreen() {
  const navigation = useNavigation();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const handleNavigationStateChange = async (navState: any) => {
    const url = navState.url.toLowerCase();

    // Landed on outline.uwaterloo.ca and not on the OIDC login redirect — authenticated
    const isOnOutline = url.includes('outline.uwaterloo.ca');
    const isLoginRedirect = url.includes('oidc/login') || url.includes('duosecurity');

    if (isOnOutline && !isLoginRedirect && !submitting) {
      try {
        const cookies = await CookieManager.get('https://outline.uwaterloo.ca', true);
        const sessionid = cookies.sessionid?.value;

        if (!sessionid) return;

        const cookieString = Object.entries(cookies)
          .map(([name, c]: [string, any]) => `${name}=${c.value}`)
          .join('; ');

        setSubmitting(true);
        await outlineService.connectWithCookies({ cookies: cookieString });
        navigation.goBack();
      } catch (error: any) {
        Alert.alert('Error', error.message || 'Failed to connect. Please try again.');
        setSubmitting(false);
      }
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <AntDesign name="close" size={24} color="#1e293b" />
        </TouchableOpacity>
        <Text style={styles.title}>Sign in to Course Outlines</Text>
        <View style={{ width: 24 }} />
      </View>

      {submitting && (
        <View style={styles.overlay}>
          <ActivityIndicator size="large" color="#6366f1" />
          <Text style={styles.overlayText}>Connecting...</Text>
        </View>
      )}

      <WebView
        source={{ uri: 'https://outline.uwaterloo.ca/' }}
        style={styles.webview}
        onNavigationStateChange={handleNavigationStateChange}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#6366f1" />
            <Text style={styles.loadingText}>Loading...</Text>
          </View>
        )}
      />

      {loading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#6366f1" />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  title: { fontSize: 18, fontWeight: '600', color: '#1e293b' },
  webview: { flex: 1 },
  loadingContainer: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#ffffff',
  },
  loadingText: { marginTop: 12, fontSize: 16, color: '#64748b' },
  overlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.95)',
    zIndex: 1000,
  },
  overlayText: { marginTop: 12, fontSize: 16, fontWeight: '600', color: '#1e293b' },
});
