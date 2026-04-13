import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { AntDesign } from '@expo/vector-icons';

export default function IntegrationsScreen() {
  const navigation = useNavigation<any>();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.header}>
        <Text style={styles.title}>Integrations</Text>
        <Text style={styles.subtitle}>
          Connect your external platforms to sync academic data and materials.
        </Text>
      </View>

      <View style={styles.cardsContainer}>
        {/* D2L Card */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconContainer, { backgroundColor: '#eef2ff' }]}>
              <AntDesign name="book" size={28} color="#6366f1" />
            </View>
            <View style={styles.cardTitleContainer}>
              <Text style={styles.cardTitle}>D2L Brightspace</Text>
              <Text style={styles.cardStatus}>Sync Courses & Notes</Text>
            </View>
          </View>
          <Text style={styles.cardDescription}>
            Import your courses, announcements, and download PDF materials directly into your study workspace.
          </Text>
          <TouchableOpacity
            style={styles.connectButton}
            onPress={() => navigation.navigate('D2LConnect')}
          >
            <Text style={styles.connectButtonText}>Manage Connection</Text>
            <AntDesign name="arrowright" size={16} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Piazza Card */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={[styles.iconContainer, { backgroundColor: '#fff7ed' }]}>
              <AntDesign name="message1" size={28} color="#f97316" />
            </View>
            <View style={styles.cardTitleContainer}>
              <Text style={styles.cardTitle}>Piazza</Text>
              <Text style={styles.cardStatus}>Sync Discussions</Text>
            </View>
          </View>
          <Text style={styles.cardDescription}>
            Keep track of course discussions and Q&A sessions. Posts are automatically processed for search.
          </Text>
          <TouchableOpacity
            style={[styles.connectButton, { backgroundColor: '#f97316' }]}
            onPress={() => navigation.navigate('PiazzaConnect')}
          >
            <Text style={styles.connectButtonText}>Manage Connection</Text>
            <AntDesign name="arrowright" size={16} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  contentContainer: {
    paddingBottom: 40,
  },
  header: {
    padding: 24,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1e293b',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: '#64748b',
    lineHeight: 22,
  },
  cardsContainer: {
    padding: 16,
  },
  card: {
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
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  iconContainer: {
    width: 56,
    height: 56,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  cardTitleContainer: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1e293b',
    marginBottom: 2,
  },
  cardStatus: {
    fontSize: 13,
    color: '#6366f1',
    fontWeight: '600',
  },
  cardDescription: {
    fontSize: 14,
    color: '#64748b',
    lineHeight: 20,
    marginBottom: 20,
  },
  connectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#6366f1',
    paddingVertical: 12,
    borderRadius: 8,
    gap: 8,
  },
  connectButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
});