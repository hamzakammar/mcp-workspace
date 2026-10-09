import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Linking,
} from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { AntDesign } from '@expo/vector-icons';
import { d2lService } from '../services/d2l';
import BookmarkButton from '../components/BookmarkButton';

interface Announcement {
  id: number;
  title: string;
  body: string;
  date: string | null;
  attachments?: Array<{ name: string; size: string }>;
}

interface Course {
  id: string;
  name: string;
  code: string;
  orgUnitId: number;
}

export default function CourseDetailScreen() {
  const route = useRoute();
  const navigation = useNavigation();
  const { course } = (route.params as { course: Course }) || {};
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [grades, setGrades] = useState<any[]>([]);
  const [assignments, setAssignments] = useState<any[]>([]);
  const [contentModules, setContentModules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [gradesLoading, setGradesLoading] = useState(false);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gradesError, setGradesError] = useState<string | null>(null);
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<'announcements' | 'grades' | 'assignments' | 'content'>('announcements');

  // --- Implementation for missing handlers ---
  async function loadAnnouncements() {
    if (!course) return;
    setLoading(true);
    setError(null);
    try {
      const data = await d2lService.getAnnouncements(course.id);
      setAnnouncements(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load announcements');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function loadGrades() {
    if (!course) return;
    setGradesLoading(true);
    setGradesError(null);
    try {
      const data = await d2lService.getGrades(course.id);
      setGrades(data);
    } catch (err: any) {
      setGradesError(err.message || 'Failed to load grades');
    } finally {
      setGradesLoading(false);
      setRefreshing(false);
    }
  }

  async function loadAssignments() {
    if (!course) return;
    setAssignmentsLoading(true);
    setAssignmentsError(null);
    try {
      const data = await d2lService.getAssignments(course.id);
      setAssignments(data);
    } catch (err: any) {
      setAssignmentsError(err.message || 'Failed to load assignments');
    } finally {
      setAssignmentsLoading(false);
      setRefreshing(false);
    }
  }

  async function loadContent() {
    if (!course) return;
    setContentLoading(true);
    setContentError(null);
    try {
      const data = await d2lService.getContent(course.id);
      setContentModules(data);
    } catch (err: any) {
      setContentError(err.message || 'Failed to load course content');
    } finally {
      setContentLoading(false);
      setRefreshing(false);
    }
  }

  function toggleModule(moduleId: string) {
    setExpandedModules(prev => {
      const next = new Set(prev);
      if (next.has(moduleId)) {
        next.delete(moduleId);
      } else {
        next.add(moduleId);
      }
      return next;
    });
  }

  function onRefresh() {
    setRefreshing(true);
    if (activeTab === 'announcements') {
      loadAnnouncements();
    } else if (activeTab === 'grades') {
      loadGrades();
    } else if (activeTab === 'assignments') {
      loadAssignments();
    } else if (activeTab === 'content') {
      loadContent();
    }
  }

  function formatDate(date: string | null | undefined): string {
    if (!date) return '';
    const d = new Date(date);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  useEffect(() => {
    if (course) {
      if (activeTab === 'announcements') {
        loadAnnouncements();
      } else if (activeTab === 'grades') {
        loadGrades();
      } else if (activeTab === 'assignments') {
        loadAssignments();
      } else if (activeTab === 'content') {
        loadContent();
      }
    }
  }, [course, activeTab]);

  if (!course) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>Course not found</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#6366f1" />
        <Text style={styles.loadingText}>Loading course content...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.courseHeader}>
          <View style={styles.courseIcon}>
            <AntDesign name="book" size={24} color="#6366f1" />
          </View>
          <View style={styles.courseInfo}>
            <Text style={styles.courseName}>{course.name}</Text>
            <Text style={styles.courseCode}>{course.code}</Text>
          </View>
        </View>
      </View>
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'announcements' && styles.activeTab]}
          onPress={() => setActiveTab('announcements')}
        >
          <AntDesign
            name="notification"
            size={18}
            color={activeTab === 'announcements' ? '#6366f1' : '#94a3b8'}
          />
          <Text style={[styles.tabText, activeTab === 'announcements' && styles.activeTabText]}>
            News
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'assignments' && styles.activeTab]}
          onPress={() => setActiveTab('assignments')}
        >
          <AntDesign
            name="checkcircleo"
            size={18}
            color={activeTab === 'assignments' ? '#6366f1' : '#94a3b8'}
          />
          <Text style={[styles.tabText, activeTab === 'assignments' && styles.activeTabText]}>
            Work
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'grades' && styles.activeTab]}
          onPress={() => setActiveTab('grades')}
        >
          <AntDesign
            name="staro"
            size={18}
            color={activeTab === 'grades' ? '#6366f1' : '#94a3b8'}
          />
          <Text style={[styles.tabText, activeTab === 'grades' && styles.activeTabText]}>
            Grades
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'content' && styles.activeTab]}
          onPress={() => setActiveTab('content')}
        >
          <AntDesign
            name="filetext1"
            size={18}
            color={activeTab === 'content' ? '#6366f1' : '#94a3b8'}
          />
          <Text style={[styles.tabText, activeTab === 'content' && styles.activeTabText]}>
            Content
          </Text>
        </TouchableOpacity>
      </View>
      {activeTab === 'announcements' && (
        <ScrollView
          style={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          {error && (
            <View style={styles.errorContainer}>
              <AntDesign name="exclamationcircleo" size={32} color="#ef4444" />
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={loadAnnouncements}>
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}
          {!error && announcements.length === 0 && (
            <View style={styles.emptyContainer}>
              <AntDesign name="notification" size={48} color="#94a3b8" />
              <Text style={styles.emptyText}>No announcements</Text>
              <Text style={styles.emptySubtext}>
                Check back later for updates from your instructor
              </Text>
            </View>
          )}
          {!error && announcements.map((announcement) => (
            <View key={announcement.id} style={styles.announcementCard}>
              <View style={styles.announcementHeader}>
                <Text style={styles.announcementTitle}>{announcement.title}</Text>
                <BookmarkButton
                  type="announcement"
                  refId={String(announcement.id)}
                  title={announcement.title}
                  metadata={{ courseId: course.id, courseCode: course.code, snippet: announcement.body?.slice(0, 150) }}
                />
              </View>
              {announcement.date && (
                <Text style={styles.announcementDate}>
                  {formatDate(announcement.date)}
                </Text>
              )}
              {announcement.body && (
                <Text style={styles.announcementBody}>{announcement.body}</Text>
              )}
              {announcement.attachments && announcement.attachments.length > 0 && (
                <View style={styles.attachmentsContainer}>
                  <Text style={styles.attachmentsLabel}>Attachments:</Text>
                  {announcement.attachments.map((att, idx) => (
                    <View key={idx} style={styles.attachmentItem}>
                      <AntDesign name="paperclip" size={14} color="#64748b" />
                      <Text style={styles.attachmentText}>
                        {att.name} ({att.size})
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}
        </ScrollView>
      )}
      {activeTab === 'grades' && (
        <ScrollView
          style={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          {gradesLoading && (
            <View style={styles.centerContainer}>
              <ActivityIndicator size="large" color="#6366f1" />
              <Text style={styles.loadingText}>Loading grades...</Text>
            </View>
          )}
          {!gradesLoading && gradesError && (
            <View style={styles.errorContainer}>
              <AntDesign name="exclamationcircleo" size={32} color="#ef4444" />
              <Text style={styles.errorText}>{gradesError}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={loadGrades}>
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}
          {!gradesLoading && !gradesError && grades.length === 0 && (
            <View style={styles.emptyContainer}>
              <AntDesign name="staro" size={48} color="#94a3b8" />
              <Text style={styles.emptyText}>No grades available</Text>
              <Text style={styles.emptySubtext}>
                Grades will appear here once they are posted
              </Text>
            </View>
          )}
          {!gradesLoading && !gradesError && grades.map((grade, index) => (
            <View key={index} style={styles.gradeCard}>
              <View style={styles.gradeHeader}>
                <Text style={styles.gradeName}>{grade.name}</Text>
                {grade.percentage && (
                  <Text style={styles.gradePercentage}>{grade.percentage}</Text>
                )}
              </View>
              {grade.score && (
                <Text style={styles.gradeScore}>{grade.score}</Text>
              )}
              {grade.feedback && (
                <View style={styles.feedbackContainer}>
                  <Text style={styles.feedbackLabel}>Feedback:</Text>
                  <Text style={styles.feedbackText}>{grade.feedback}</Text>
                </View>
              )}
              {grade.lastModified && (
                <Text style={styles.gradeDate}>
                  Updated: {formatDate(grade.lastModified)}
                </Text>
              )}
            </View>
          ))}
        </ScrollView>
      )}
      {activeTab === 'assignments' && (
        <ScrollView
          style={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {assignmentsLoading && (
            <View style={styles.centerContainer}>
              <ActivityIndicator size="large" color="#6366f1" />
              <Text style={styles.loadingText}>Loading assignments...</Text>
            </View>
          )}
          {!assignmentsLoading && assignmentsError && (
            <View style={styles.errorContainer}>
              <AntDesign name="exclamationcircleo" size={32} color="#ef4444" />
              <Text style={styles.errorText}>{assignmentsError}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={loadAssignments}>
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}
          {!assignmentsLoading && !assignmentsError && assignments.length === 0 && (
            <View style={styles.emptyContainer}>
              <AntDesign name="checkcircleo" size={48} color="#94a3b8" />
              <Text style={styles.emptyText}>No assignments</Text>
              <Text style={styles.emptySubtext}>Nothing due right now</Text>
            </View>
          )}
          {!assignmentsLoading && !assignmentsError && assignments.map((a, i) => (
            <View key={a.id || i} style={styles.gradeCard}>
              <View style={styles.gradeHeader}>
                <Text style={styles.gradeName}>{a.name || a.title || 'Assignment'}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  {a.score !== undefined && a.score !== null && (
                    <Text style={styles.gradePercentage}>{a.score}</Text>
                  )}
                  <BookmarkButton
                    type="assignment"
                    refId={String(a.id || i)}
                    title={a.name || a.title || 'Assignment'}
                    metadata={{ courseId: course.id, courseCode: course.code, dueDate: a.dueDate }}
                  />
                </View>
              </View>
              {a.dueDate && (
                <Text style={styles.gradeScore}>Due: {formatDate(a.dueDate)}</Text>
              )}
              {a.completionStatus && (
                <Text style={[styles.gradeScore, a.completionStatus === 'Completed' && { color: '#16a34a' }]}>
                  {a.completionStatus}
                </Text>
              )}
              {a.instructions && (
                <Text style={styles.feedbackText} numberOfLines={3}>{a.instructions}</Text>
              )}
            </View>
          ))}
        </ScrollView>
      )}
      {activeTab === 'content' && (
        <ScrollView
          style={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {contentLoading && (
            <View style={styles.centerContainer}>
              <ActivityIndicator size="large" color="#6366f1" />
              <Text style={styles.loadingText}>Loading content...</Text>
            </View>
          )}
          {!contentLoading && contentError && (
            <View style={styles.errorContainer}>
              <AntDesign name="exclamationcircleo" size={32} color="#ef4444" />
              <Text style={styles.errorText}>{contentError}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={loadContent}>
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}
          {!contentLoading && !contentError && contentModules.length === 0 && (
            <View style={styles.emptyContainer}>
              <AntDesign name="filetext1" size={48} color="#94a3b8" />
              <Text style={styles.emptyText}>No content available</Text>
              <Text style={styles.emptySubtext}>Course modules will appear here</Text>
            </View>
          )}
          {!contentLoading && !contentError && contentModules.map((mod, i) => (
            <View key={mod.id || i} style={styles.moduleCard}>
              <TouchableOpacity
                style={styles.moduleHeader}
                onPress={() => toggleModule(mod.id || String(i))}
              >
                <AntDesign name="folder1" size={20} color="#6366f1" />
                <Text style={styles.moduleName}>{mod.title || mod.name || 'Module'}</Text>
                <AntDesign
                  name={expandedModules.has(mod.id || String(i)) ? 'up' : 'down'}
                  size={16}
                  color="#94a3b8"
                />
              </TouchableOpacity>
              {expandedModules.has(mod.id || String(i)) && mod.topics && mod.topics.map((topic: any, j: number) => {
                const isPdf = topic.url && (
                  topic.url.toLowerCase().includes('.pdf') ||
                  topic.type === 'File' ||
                  topic.type === 'Link'
                );
                return (
                  <TouchableOpacity
                    key={topic.id || j}
                    style={styles.topicItem}
                    onPress={() => {
                      if (!topic.url) return;
                      // Absolute URLs off D2L (instructor-added external links) open in the
                      // browser — the backend file proxy only serves the user's D2L host.
                      if (/^https?:\/\//i.test(topic.url) && topic.type === 'Link') {
                        Linking.openURL(topic.url).catch(() => {});
                        return;
                      }
                      {
                        (navigation.navigate as any)('PDFViewer', {
                          title: topic.title || topic.name || 'Document',
                          courseId: course.id,
                          fileUrl: topic.url,
                        });
                      }
                    }}
                    disabled={!topic.url}
                  >
                    <AntDesign
                      name={isPdf ? 'pdffile1' : topic.url ? 'link' : 'filetext1'}
                      size={16}
                      color={topic.url ? '#6366f1' : '#94a3b8'}
                    />
                    <Text style={[styles.topicName, !topic.url && styles.topicNameDisabled]}>
                      {topic.title || topic.name || 'Topic'}
                    </Text>
                    {topic.url && (
                      <AntDesign name="right" size={12} color="#94a3b8" />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#f8fafc',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#64748b',
  },
  header: {
    backgroundColor: '#ffffff',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  courseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  courseIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#eef2ff',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  courseInfo: {
    flex: 1,
  },
  courseName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1e293b',
    marginBottom: 4,
  },
  courseCode: {
    fontSize: 14,
    color: '#64748b',
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    gap: 8,
  },
  activeTab: {
    borderBottomWidth: 2,
    borderBottomColor: '#6366f1',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#94a3b8',
  },
  activeTabText: {
    color: '#6366f1',
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  errorContainer: {
    padding: 24,
    alignItems: 'center',
  },
  errorText: {
    marginTop: 12,
    fontSize: 16,
    color: '#ef4444',
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: '#6366f1',
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  emptyText: {
    marginTop: 16,
    fontSize: 18,
    fontWeight: '600',
    color: '#1e293b',
  },
  emptySubtext: {
    marginTop: 8,
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
  },
  announcementCard: {
    backgroundColor: '#ffffff',
    margin: 16,
    marginBottom: 0,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  announcementHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  announcementTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
    flex: 1,
    marginRight: 8,
  },
  announcementDate: {
    fontSize: 12,
    color: '#64748b',
  },
  announcementBody: {
    fontSize: 15,
    color: '#475569',
    lineHeight: 22,
    marginBottom: 12,
  },
  attachmentsContainer: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  attachmentsLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 8,
  },
  attachmentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  attachmentText: {
    fontSize: 14,
    color: '#64748b',
  },
  gradeCard: {
    backgroundColor: '#ffffff',
    margin: 16,
    marginBottom: 0,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  gradeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  gradeName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1e293b',
    flex: 1,
    marginRight: 12,
  },
  gradePercentage: {
    fontSize: 16,
    fontWeight: '700',
    color: '#6366f1',
  },
  gradeScore: {
    fontSize: 14,
    color: '#64748b',
    marginBottom: 8,
  },
  feedbackContainer: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  feedbackLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 4,
  },
  feedbackText: {
    fontSize: 14,
    color: '#475569',
    lineHeight: 20,
  },
  gradeDate: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 8,
  },
  moduleCard: {
    backgroundColor: '#ffffff',
    margin: 16,
    marginBottom: 0,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
  },
  moduleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 10,
  },
  moduleName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
  },
  topicItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
    backgroundColor: '#f8fafc',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  topicName: {
    flex: 1,
    fontSize: 14,
    color: '#475569',
  },
  topicNameDisabled: {
    color: '#94a3b8',
  },
});
