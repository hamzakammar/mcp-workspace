import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
  Modal,
  FlatList,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { AntDesign } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { notesService } from '../services/notes';
import { d2lService } from '../services/d2l';

interface Course {
  id: string;
  name: string;
  code: string;
}

export default function UploadScreen() {
  const [file, setFile] = useState<DocumentPicker.DocumentPickerResult | null>(null);
  const [title, setTitle] = useState('');
  const [courseId, setCourseId] = useState('');
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [showCoursePicker, setShowCoursePicker] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const navigation = useNavigation();

  const loadCourses = async () => {
    try {
      setLoadingCourses(true);
      const data = await d2lService.getCourses();
      setCourses(data);
    } catch (error: any) {
      console.error('Error loading courses:', error);
      // Don't show error - courses are optional
    } finally {
      setLoadingCourses(false);
    }
  };

  useEffect(() => {
    loadCourses();
  }, []);

  const selectCourse = (course: Course) => {
    setSelectedCourse(course);
    setCourseId(course.id);
    setShowCoursePicker(false);
  };

  const pickDocument = async () => {
    try {
      // Request permissions first (iOS may need this)
      const permissionResult = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (permissionResult.canceled) {
        return; // User cancelled, don't show error
      }

      if (permissionResult.assets && permissionResult.assets[0]) {
        const asset = permissionResult.assets[0];
        if (!asset.uri) {
          Alert.alert('Error', 'Invalid file selected');
          return;
        }
        setFile(permissionResult);
        if (!title) {
          setTitle(asset.name.replace('.pdf', ''));
        }
      } else {
        Alert.alert('Error', 'No file selected');
      }
    } catch (error: any) {
      console.error('Error picking document:', error);
      const errorMessage = error?.message || 'Failed to pick document';
      Alert.alert('Error', errorMessage);
    }
  };

  const handleUpload = async (retryCount = 0) => {
    if (!file || file.canceled || !file.assets || !file.assets[0]) {
      Alert.alert('Error', 'Please select a file');
      return;
    }

    const asset = file.assets[0];
    if (!asset.uri) {
      Alert.alert('Error', 'Invalid file');
      return;
    }

    setError(null);
    setUploading(true);
    setUploadProgress(0);

    try {
      // Step 1: Get presigned URL
      setUploadProgress(10);
      const presignResponse = await notesService.presignUpload({
        filename: asset.name || 'document.pdf',
        contentType: asset.mimeType || 'application/pdf',
        size: asset.size || 0,
        courseId: courseId || undefined,
      });

      // Step 2: Upload file to S3
      setUploadProgress(30);
      await notesService.uploadFile(
        presignResponse.uploadUrl,
        asset.uri,
        asset.mimeType || 'application/pdf'
      );

      setUploadProgress(60);
      setUploading(false);
      setProcessing(true);

      // Step 3: Process the note
      setUploadProgress(80);
      const processResponse = await notesService.processNote({
        s3Key: presignResponse.s3Key,
        courseId: courseId || undefined,
        title: title || asset.name.replace('.pdf', ''),
      });

      setUploadProgress(100);

      Alert.alert(
        'Success',
        `Note processed successfully!\n${processResponse.chunkCount} chunks created from ${processResponse.pageCount} pages.`,
        [
          {
            text: 'OK',
            onPress: () => {
              // Reset form
              setFile(null);
              setTitle('');
              setCourseId('');
              setSelectedCourse(null);
              setProcessing(false);
              setUploadProgress(0);
              // Navigate back
              navigation.goBack();
            },
          },
        ]
      );
    } catch (error: any) {
      console.error('Upload error:', error);
      console.error('Upload error response:', error.data);
      console.error('Upload error status:', error.status);

      // Get detailed error message
      const errorMessage = error.data?.error ||
        error.data?.details ||
        error.data?.message ||
        error.message ||
        'An error occurred during upload';

      // Include status code if available
      const fullErrorMessage = error.status
        ? `[${error.status}] ${errorMessage}`
        : errorMessage;

      setError(fullErrorMessage);

      // Retry logic (max 2 retries)
      if (retryCount < 2) {
        Alert.alert(
          'Upload Failed',
          `${errorMessage}\n\nWould you like to retry?`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Retry',
              onPress: () => {
                setTimeout(() => handleUpload(retryCount + 1), 1000);
              },
            },
          ]
        );
      } else {
        Alert.alert('Upload Failed', errorMessage);
      }
    } finally {
      setUploading(false);
      setProcessing(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <Text style={styles.title}>Upload Note</Text>

      <View style={styles.section}>
        <Text style={styles.label}>File</Text>
        <TouchableOpacity
          style={styles.fileButton}
          onPress={() => {
            try {
              pickDocument();
            } catch (error: any) {
              console.error('Error in pickDocument:', error);
              Alert.alert('Error', error?.message || 'Failed to open document picker');
            }
          }}
          disabled={uploading || processing}
        >
          <AntDesign
            name={file && !file.canceled && file.assets && file.assets[0] ? "file-text" : "cloud-upload"}
            size={24}
            color="#6366f1"
            style={{ marginBottom: 8 }}
          />
          <Text style={styles.fileButtonText}>
            {file && !file.canceled && file.assets && file.assets[0]
              ? file.assets[0].name
              : 'Select PDF File'}
          </Text>
          {file && !file.canceled && file.assets && file.assets[0] && file.assets[0].size !== undefined && (
            <Text style={styles.fileSize}>
              {(file.assets[0].size / 1024 / 1024).toFixed(2)} MB
            </Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Title (optional)</Text>
        <TextInput
          style={styles.input}
          placeholder="Note title"
          value={title}
          onChangeText={setTitle}
          editable={!uploading && !processing}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Course (optional)</Text>
        <TouchableOpacity
          style={styles.coursePicker}
          onPress={() => setShowCoursePicker(true)}
          disabled={uploading || processing || loadingCourses}
        >
          <Text style={[styles.coursePickerText, !selectedCourse && styles.coursePickerPlaceholder]}>
            {selectedCourse ? `${selectedCourse.code} - ${selectedCourse.name}` : 'Select a course'}
          </Text>
          <AntDesign name="down" size={16} color="#64748b" />
        </TouchableOpacity>
        {selectedCourse && (
          <TouchableOpacity
            style={styles.clearCourseButton}
            onPress={() => {
              setSelectedCourse(null);
              setCourseId('');
            }}
          >
            <Text style={styles.clearCourseText}>Clear selection</Text>
          </TouchableOpacity>
        )}
      </View>

      {error && (
        <View style={styles.errorContainer}>
          <AntDesign name="exclamationcircleo" size={20} color="#ef4444" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {(uploading || processing) && (
        <View style={styles.progressContainer}>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${uploadProgress}%` }]} />
          </View>
          <Text style={styles.statusText}>
            {uploading ? `Uploading... ${uploadProgress}%` : `Processing... ${uploadProgress}%`}
          </Text>
        </View>
      )}

      <TouchableOpacity
        style={[
          styles.uploadButton,
          (uploading || processing || !file || file.canceled) && styles.uploadButtonDisabled,
        ]}
        onPress={() => handleUpload()}
        disabled={uploading || processing || !file || file.canceled}
      >
        {uploading || processing ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <AntDesign name="upload" size={18} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.uploadButtonText}>Upload & Process</Text>
          </>
        )}
      </TouchableOpacity>

      <Modal
        visible={showCoursePicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowCoursePicker(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Course</Text>
              <TouchableOpacity onPress={() => setShowCoursePicker(false)}>
                <AntDesign name="close" size={24} color="#1e293b" />
              </TouchableOpacity>
            </View>
            {loadingCourses ? (
              <View style={styles.modalLoading}>
                <ActivityIndicator size="large" color="#6366f1" />
              </View>
            ) : (
              <FlatList
                data={courses}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.courseItem}
                    onPress={() => selectCourse(item)}
                  >
                    <Text style={styles.courseItemCode}>{item.code}</Text>
                    <Text style={styles.courseItemName}>{item.name}</Text>
                  </TouchableOpacity>
                )}
                ListEmptyComponent={
                  <View style={styles.modalEmpty}>
                    <Text style={styles.modalEmptyText}>No courses available</Text>
                  </View>
                }
              />
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  contentContainer: {
    padding: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 32,
    color: '#1e293b',
  },
  section: {
    marginBottom: 28,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 10,
    color: '#1e293b',
  },
  input: {
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    backgroundColor: '#f8fafc',
    color: '#1e293b',
  },
  fileButton: {
    borderWidth: 2,
    borderColor: '#6366f1',
    borderStyle: 'dashed',
    borderRadius: 12,
    padding: 24,
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    minHeight: 120,
    justifyContent: 'center',
  },
  fileButtonText: {
    color: '#6366f1',
    fontSize: 16,
    fontWeight: '600',
  },
  fileSize: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 4,
  },
  coursePicker: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 16,
    backgroundColor: '#f8fafc',
  },
  coursePickerText: {
    fontSize: 16,
    color: '#1e293b',
    flex: 1,
  },
  coursePickerPlaceholder: {
    color: '#94a3b8',
  },
  clearCourseButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  clearCourseText: {
    color: '#6366f1',
    fontSize: 14,
    fontWeight: '600',
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    gap: 8,
  },
  errorText: {
    flex: 1,
    color: '#dc2626',
    fontSize: 14,
  },
  progressContainer: {
    marginBottom: 16,
  },
  progressBar: {
    height: 8,
    backgroundColor: '#e2e8f0',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#6366f1',
    borderRadius: 4,
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#6366f1',
    borderRadius: 12,
    padding: 18,
    marginTop: 24,
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  uploadButtonDisabled: {
    opacity: 0.6,
  },
  uploadButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  statusText: {
    textAlign: 'center',
    color: '#64748b',
    fontSize: 14,
    fontWeight: '500',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
    paddingBottom: 24,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1e293b',
  },
  modalLoading: {
    padding: 40,
    alignItems: 'center',
  },
  modalEmpty: {
    padding: 40,
    alignItems: 'center',
  },
  modalEmptyText: {
    color: '#64748b',
    fontSize: 16,
  },
  courseItem: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  courseItemCode: {
    fontSize: 16,
    fontWeight: '600',
    color: '#6366f1',
    marginBottom: 4,
  },
  courseItemName: {
    fontSize: 14,
    color: '#64748b',
  },
});
