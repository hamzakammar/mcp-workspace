import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Dimensions,
} from 'react-native';

import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { AntDesign } from '@expo/vector-icons';
import { dashboardService } from '../services/dashboard';
import { d2lService } from '../services/d2l';
import { DashboardResponse } from '../types';
import { useAuth } from '../context/AuthContext';
import { colors } from '../theme';

interface UpcomingAssignment {
  courseId: string;
  courseName: string;
  courseCode: string;
  name: string;
  dueDate: string;
}


const windowH = Dimensions.get('window').height;

export default function DashboardScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { user } = useAuth();
  const hasFocusedOnce = useRef(false);

  const loadUpcoming = useCallback(async () => {
    try {
      const courses = await d2lService.getCourses();
      const now = new Date();
      const cutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const allAssignments: UpcomingAssignment[] = [];
      await Promise.all(
        courses.slice(0, 6).map(async (course: any) => {
          try {
            const assignments = await d2lService.getAssignments(course.id);
            for (const a of assignments) {
              // Use dueDateIso (raw ISO) for reliable date comparison
              const rawDate = a.dueDateIso || a.dueDate;
              if (rawDate) {
                const due = new Date(rawDate);
                if (!isNaN(due.getTime()) && due >= now && due <= cutoff) {
                  allAssignments.push({
                    courseId: course.id,
                    courseName: course.name,
                    courseCode: course.code,
                    name: a.name || a.title || 'Assignment',
                    dueDate: rawDate,
                  });
                }
              }
            }
          } catch {
            // skip failed courses silently
          }
        })
      );
      allAssignments.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
      setUpcoming(allAssignments);
    } catch {
      // Upcoming is non-critical, fail silently
    }
  }, []);

  const loadDashboard = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      if (opts?.silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      const data = await dashboardService.getDashboard();
      setDashboard(data);
      loadUpcoming(); // non-blocking
    } catch (error: any) {
      console.error('Error loading dashboard:', error);
      // Show user-friendly error message
      if (error.status === 401) {
        // Unauthorized - token issue
        const errorMsg = error.data?.error || 'Authentication failed';
        console.warn('Unauthorized (401):', errorMsg);
        Alert.alert(
          'Authentication Error',
          errorMsg + '\n\nPlease try logging out and logging back in.',
          [{ text: 'OK' }]
        );
      } else if (error.status === 502 || error.status === 504) {
        // Backend not available or timeout
        console.warn('Backend server not available or timed out. Make sure the backend is running.');
      } else if (error.status === 503) {
        // Service unavailable - likely database issue
        const errorMsg = error.data?.message || error.data?.error || 'Database connection issue';
        console.warn('Service unavailable (503):', errorMsg);
        Alert.alert(
          'Service Unavailable',
          errorMsg + '\n\nThis usually means the database is not configured or not accessible. Check backend logs.',
          [{ text: 'OK' }]
        );
      } else if (error.code === 'ECONNREFUSED' || error.message?.includes('Network Error')) {
        console.warn('Cannot connect to backend. Check API_BASE_URL configuration.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadUpcoming]);

  useFocusEffect(
    useCallback(() => {
      loadDashboard({ silent: hasFocusedOnce.current });
      hasFocusedOnce.current = true;
    }, [loadDashboard])
  );

  const onRefresh = () => {
    loadDashboard({ silent: true });
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.loadingText}>Loading dashboard...</Text>
      </View>
    );
  }

  const bottomPad = 24 + Math.max(insets.bottom, 12) + 56;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[
          styles.contentContainer,
          { paddingBottom: bottomPad, minHeight: windowH - 40 },
        ]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        {/* Header with gradient effect */}
        <View style={styles.header}>
          <View>
            <Text style={styles.greeting}>Welcome back</Text>
            <Text style={styles.userName}>
              {(() => {
                // Check if name exists and is not a UUID
                const isUUID = (str: string | undefined): boolean => {
                  if (!str) return false;
                  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                  return uuidRegex.test(str);
                };

                if (user?.name && !isUUID(user.name)) {
                  return user.name;
                }

                // Fall back to formatted email
                if (user?.email) {
                  return user.email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                }

                return 'User';
              })()}
            </Text>
          </View>
        </View>

        {/* Stats Cards */}
        <View style={styles.statsContainer}>
          <View style={[styles.statCard, styles.statCardPrimary]}>
            <View style={styles.statIconContainer}>
              <AntDesign name="book" size={24} color={colors.accent} />
            </View>
            <Text style={styles.statValue}>{dashboard?.stats?.notesCount || 0}</Text>
            <Text style={styles.statLabel}>Total Notes</Text>
          </View>
          <View style={[styles.statCard, styles.statCardSecondary]}>
            <View style={styles.statIconContainer}>
              <AntDesign name="filetext1" size={24} color={colors.secondary} />
            </View>
            <Text style={styles.statValue}>{dashboard?.usage?.totalChunks || 0}</Text>
            <Text style={styles.statLabel}>Chunks</Text>
          </View>
        </View>

        {/* Recent notes first — full-width, primary */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Your PDFs & notes</Text>
            <TouchableOpacity
              onPress={() => navigation.navigate('Notes' as never)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.viewAllLink}>View all</Text>
            </TouchableOpacity>
          </View>
          {dashboard?.recentNotes && dashboard.recentNotes.length > 0 ? (
            dashboard.recentNotes.map((note, index) => (
              <TouchableOpacity
                key={note.id || `recent-${index}`}
                style={styles.noteCard}
                activeOpacity={0.7}
              >
                <View style={styles.noteCardHeader}>
                  <View style={styles.noteIcon}>
                    <AntDesign name="pdffile1" size={22} color={colors.accent} />
                  </View>
                  <View style={styles.noteContent}>
                    <Text style={styles.noteTitle} numberOfLines={2}>{note.title}</Text>
                    {(note.courseId || note.course_id) && (
                      <View style={styles.courseBadge}>
                        <Text style={styles.courseText}>{note.courseId || note.course_id}</Text>
                      </View>
                    )}
                  </View>
                </View>
                <View style={styles.noteFooter}>
                  <Text style={styles.noteDate}>
                    {new Date(note.createdAt || note.created_at || '').toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </Text>
                  {note.status && (
                    <View style={[styles.statusBadge, note.status === 'ready' && styles.statusReady]}>
                      <Text style={styles.statusText}>{note.status}</Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            ))
          ) : (
            <View style={styles.notesEmptyPanel}>
              <AntDesign name="pdffile1" size={40} color={colors.muted} />
              <Text style={styles.notesEmptyTitle}>No PDFs yet</Text>
              <Text style={styles.notesEmptySub}>Open the Notes tab and tap Upload to add a file.</Text>
              <TouchableOpacity
                style={styles.notesEmptyCta}
                onPress={() => navigation.navigate('Notes' as never)}
                activeOpacity={0.8}
              >
                <Text style={styles.notesEmptyCtaText}>Go to Notes</Text>
                <AntDesign name="right" size={16} color="#fff" />
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* My Courses Card */}
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.coursesCard}
            onPress={() => navigation.navigate('Courses' as never)}
            activeOpacity={0.7}
          >
            <View style={styles.coursesCardContent}>
              <View style={styles.coursesIconContainer}>
                <AntDesign name="book" size={28} color={colors.accent} />
              </View>
              <View style={styles.coursesTextContainer}>
                <Text style={styles.coursesTitle}>My Courses</Text>
                <Text style={styles.coursesSubtitle}>View your D2L courses and announcements</Text>
              </View>
              <AntDesign name="right" size={20} color={colors.muted} />
            </View>
          </TouchableOpacity>
        </View>

        {/* Upcoming Assignments Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Due This Week</Text>
          {upcoming.length > 0 ? (
            upcoming.map((item, i) => (
              <View key={i} style={styles.upcomingCard}>
                <View style={styles.upcomingLeft}>
                  <View style={styles.dueDateBox}>
                    <Text style={styles.dueDateDay}>
                      {new Date(item.dueDate).toLocaleDateString('en-US', { day: 'numeric' })}
                    </Text>
                    <Text style={styles.dueDateMonth}>
                      {new Date(item.dueDate).toLocaleDateString('en-US', { month: 'short' })}
                    </Text>
                  </View>                </View>
                <View style={styles.upcomingContent}>
                  <Text style={styles.upcomingName} numberOfLines={1}>{item.name}</Text>
                  <View style={styles.courseBadge}>
                    <Text style={styles.courseText}>{item.courseCode}</Text>
                  </View>
                </View>
              </View>
            ))
          ) : (
            <View style={styles.emptyState}>
              <AntDesign name="checkcircleo" size={36} color={colors.muted} />
              <Text style={styles.emptyText}>Nothing due this week</Text>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    flexGrow: 1,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  viewAllLink: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.accent,
  },
  notesEmptyPanel: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 28,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  notesEmptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    marginTop: 14,
    marginBottom: 6,
  },
  notesEmptySub: {
    fontSize: 14,
    color: colors.info,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
    paddingHorizontal: 8,
  },
  notesEmptyCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.accent,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
  },
  notesEmptyCtaText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: colors.info,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 16,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  greeting: {
    fontSize: 14,
    color: colors.info,
    marginBottom: 4,
    fontWeight: '500',
  },
  userName: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    textTransform: 'capitalize',
  },
  statsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 24,
    paddingTop: 24,
    gap: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  statCardPrimary: {
    borderLeftWidth: 4,
    borderLeftColor: colors.accent,
  },
  statCardSecondary: {
    borderLeftWidth: 4,
    borderLeftColor: colors.secondary,
  },
  statIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.light,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  statValue: {
    fontSize: 32,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 13,
    color: colors.info,
    fontWeight: '500',
  },
  section: {
    paddingHorizontal: 24,
    paddingTop: 32,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1e293b',
    marginBottom: 16,
  },
  noteCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  noteCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  noteIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.light,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  noteContent: {
    flex: 1,
  },
  noteTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 6,
  },
  courseBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.light,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  courseText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent,
  },
  noteFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.light,
  },
  noteDate: {
    fontSize: 12,
    color: colors.muted,
    fontWeight: '500',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.light,
  },
  statusReady: {
    backgroundColor: '#dcfce7', // Consider using a Horizon accent if needed
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.info,
    textTransform: 'capitalize',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: colors.info,
    textAlign: 'center',
  },
  coursesCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 20,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
    borderLeftWidth: 4,
    borderLeftColor: colors.accent,
  },
  coursesCardContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  coursesIconContainer: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.light,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  coursesTextContainer: {
    flex: 1,
  },
  coursesTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 4,
  },
  coursesSubtitle: {
    fontSize: 14,
    color: colors.info,
  },
  upcomingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  upcomingLeft: {
    marginRight: 14,
  },
  dueDateBox: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: colors.accent + '22',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dueDateDay: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.accent,
    lineHeight: 18,
  },
  dueDateMonth: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.accent,
    textTransform: 'uppercase',
  },
  upcomingContent: {
    flex: 1,
  },
  upcomingName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 6,
  },
});
