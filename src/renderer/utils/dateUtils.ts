/**
 * Date utility functions for project categorization and formatting
 */

import { Project } from '../services/projectsApi';

export type ProjectCategory =
  | 'Today'
  | 'Yesterday'
  | 'Last 7 days'
  | 'Last 30 days'
  | 'Older';

/**
 * Get the category for a project based on its update date
 */
export const getCategoryFromDate = (dateString: string): ProjectCategory => {
  try {
    const date = new Date(dateString);

    // Handle invalid dates
    if (isNaN(date.getTime())) {
      return 'Older';
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffMs = today.getTime() - dateOnly.getTime();
    const daysDiff = Math.floor(diffMs / (24 * 60 * 60 * 1000));

    // Handle future dates (clock skew)
    if (daysDiff < 0) return 'Today';

    if (daysDiff === 0) return 'Today';
    if (daysDiff === 1) return 'Yesterday';
    if (daysDiff < 7) return 'Last 7 days';
    if (daysDiff < 30) return 'Last 30 days';
    return 'Older';
  } catch {
    return 'Older'; // Fallback for any errors
  }
};

/**
 * Format date with relative time for recent updates
 */
export const formatProjectDate = (dateString: string): string => {
  try {
    const date = new Date(dateString);

    if (isNaN(date.getTime())) {
      return 'Unknown date';
    }

    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / (60 * 1000));
    const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
    const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

    // For today, show relative time
    if (diffDays === 0) {
      if (diffMinutes < 1) return 'Just now';
      if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
      return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    }

    // For yesterday
    if (diffDays === 1) {
      return 'Yesterday';
    }

    // For older dates, show formatted date
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return 'Unknown date';
  }
};

/**
 * Sort and categorize projects by update date
 */
export const categorizeProjects = (projects: Project[]): Record<ProjectCategory, Project[]> => {
  // Sort by updated_at descending (most recent first)
  const sorted = [...projects].sort((a, b) => {
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  // Initialize empty categories
  const categorized: Record<ProjectCategory, Project[]> = {
    'Today': [],
    'Yesterday': [],
    'Last 7 days': [],
    'Last 30 days': [],
    'Older': [],
  };

  // Group projects into categories
  sorted.forEach(project => {
    const category = getCategoryFromDate(project.updated_at);
    categorized[category].push(project);
  });

  return categorized;
};

/**
 * Get ordered list of categories (for consistent rendering order)
 */
export const getCategoryOrder = (): ProjectCategory[] => {
  return ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Older'];
};
