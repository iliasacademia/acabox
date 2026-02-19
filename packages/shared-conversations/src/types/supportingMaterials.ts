/**
 * Supporting Materials Types
 *
 * Type definitions for the supporting materials feature that allows users
 * to upload and manage reference files (papers, proposals, notes) to improve
 * manuscript reviews.
 */

export type SupportingMaterialFileType = 'pdf' | 'doc' | 'docx' | 'txt' | 'md' | 'tex' | 'rtf';

export type SupportingMaterialCategory = 'reference' | 'note' | 'proposal' | 'other';

export interface SupportingMaterial {
  id: number;
  project_id: number;
  file_name: string;
  file_path: string;
  file_type: SupportingMaterialFileType;
  category: SupportingMaterialCategory;
  size: number;
  created_at: string;
  updated_at: string;
  is_manuscript?: boolean; // Omit or false for supporting materials, true for manuscripts
}
