import React, { useState, useRef, useEffect } from 'react';
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
import { piazzaService } from '../../services/piazza';

export default function PiazzaWebViewScreen() {
  const navigation = useNavigation();
  const webViewRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [capturedCookies, setCapturedCookies] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Guards against double submits: navigation events fire repeatedly and `submitting` state is stale in closures
  const submittedRef = useRef(false);

  const piazzaUrl = 'https://piazza.com/';

  // On mount, clear existing WebView cookies so we always start from a clean Piazza login state
  useEffect(() => {
    (async () => {
      try {
        if (__DEV__) console.log('[Piazza WebView] Clearing WebView cookies on mount');
        await CookieManager.clearAll(true);
      } catch (error) {
        console.warn('[Piazza WebView] Failed to clear cookies on mount:', error);
      }
    })();
  }, []);

  const handleNavigationStateChange = async (navState: any) => {
    // Check if we've navigated to a Piazza authenticated page (successful login)
    // Piazza redirects to /class/{nid}, dashboard, or home after login
    const url = navState.url.toLowerCase();
    
    // More specific checks for authenticated pages
    const isLoginPage = url.includes('/account/login') || url.includes('/login');
    const isAuthenticated = url.includes('/class/') || 
                           url.includes('/account/settings') ||
                           (url.includes('piazza.com') && !isLoginPage && url !== 'https://piazza.com/' && url !== 'https://www.piazza.com/');

    if (isAuthenticated && !isLoginPage) {
      if (__DEV__) console.log('[Piazza WebView] Navigated to authenticated page:', url);
      if (__DEV__) console.log('[Piazza WebView] Capturing cookies...');
      
      try {
        // Get all cookies for piazza.com domain
        const cookies = await CookieManager.get('https://piazza.com', true);
        if (__DEV__) console.log('[Piazza WebView] Retrieved cookies:', Object.keys(cookies));
        
        // Extract session_id (main Piazza cookie)
        const sessionId = cookies.session_id?.value;
        
        if (sessionId) {
          // Format cookies as a cookie string (same format as D2L)
          const cookieString = Object.entries(cookies)
            .map(([name, cookie]: [string, any]) => `${name}=${cookie.value}`)
            .join('; ');
          
          if (__DEV__) console.log('[Piazza WebView] Session cookie found! Cookie string length:', cookieString.length);
          setCapturedCookies(cookieString);
          
          // Automatically connect and navigate back
          if (!submittedRef.current) {
            submittedRef.current = true;
            setTimeout(() => handleSubmit(cookieString, true), 500);
          }
        } else {
          if (__DEV__) console.log('[Piazza WebView] Missing session_id cookie. Available cookies:', Object.keys(cookies));
        }
      } catch (error: any) {
        console.error('[Piazza WebView] Error capturing cookies:', error);
        Alert.alert('Error', 'Failed to capture session cookies. Please try again.');
      }
    }
  };

  const handleSubmit = async (cookieString?: string, alreadyClaimed = false) => {
    const cookiesToUse = cookieString || capturedCookies;
    
    if (!cookiesToUse) {
      if (alreadyClaimed) submittedRef.current = false;
      Alert.alert('No Credentials', 'Please log in first.');
      return;
    }

    if (!alreadyClaimed) {
      if (submittedRef.current) return;
      submittedRef.current = true;
    }
    setSubmitting(true);
    try {
      await piazzaService.connectWithCookies({ cookies: cookiesToUse });
      
      // Small delay to ensure backend has processed
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Automatically navigate back to dashboard on success
      navigation.goBack();
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to connect');
      submittedRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <AntDesign name="close" size={24} color="#1e293b" />
        </TouchableOpacity>
        <Text style={styles.title}>Sign in to Piazza</Text>
        <View style={{ width: 24 }} />
      </View>

      {submitting && (
        <View style={styles.submittingOverlay}>
          <ActivityIndicator size="large" color="#6366f1" />
          <Text style={styles.submittingText}>Connecting...</Text>
        </View>
      )}

      <WebView
        ref={webViewRef}
        source={{ uri: piazzaUrl }}
        style={styles.webview}
        onNavigationStateChange={handleNavigationStateChange}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        startInLoadingState={true}
        renderLoading={() => (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#6366f1" />
            <Text style={styles.loadingText}>Loading Piazza...</Text>
          </View>
        )}
      />

      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#6366f1" />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
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
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1e293b',
  },
  webview: {
    flex: 1,
  },
  loadingContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#ffffff',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#64748b',
  },
  submittingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    zIndex: 1000,
  },
  submittingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#1e293b',
    fontWeight: '600',
  },
});
