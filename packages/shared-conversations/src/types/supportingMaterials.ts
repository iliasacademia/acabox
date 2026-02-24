/**
 * Supporting Materials Types
 *
 * Type definitions for the supporting materials feature that allows users
 * to upload and manage reference files (papers, proposals, notes) to improve
 * manuscript reviews.
 */

export type SupportingMaterialFileType = 'pdf' | 'doc' | 'docx' | 'txt' | 'md' | 'tex' | 'rtf';

export type SupportingMaterialCategory = 'reference' | 'note' | 'proposal' | 'other';

export type SupportingMaterialTag = 'manuscript' | 'reference' | 'proposal' | 'other' | null;

export type UploadStatus = 'pending' | 'completed' | 'failed' | null;

export interface SupportingMaterial {
  id: number;
  project_id: number;
  file_name: string;
  file_path: string;
  file_type?: SupportingMaterialFileType;
  category?: SupportingMaterialCategory;
  tag?: SupportingMaterialTag; // AI-classified tag after upload completes
  size?: number;
  created_at: string;
  updated_at: string;
  is_primary_manuscript?: boolean; // false for supporting materials, true for manuscripts
  upload_status?: UploadStatus; // Upload progress status
  summary?: string | null; // AI-generated 2-3 sentence summary (PDF/DOCX only)
  last_review?: string | null;
}

export interface UploadResponse {
  file: SupportingMaterial;
  uploaded: boolean;
}

export interface FileUploadEvent {
  project_id: number;
  user_id: number;
  event_name: 'file_upload_started' | 'file_upload_completed' | 'file_upload_failed';
  data: {
    file_id: number;
    file_name: string;
    error?: string; // Only present on file_upload_failed
  };
  timestamp: string;
}

export interface EventsPollResponse {
  events: FileUploadEvent[];
}
