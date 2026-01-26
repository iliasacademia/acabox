import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { getUserPreferences, updateUserPreferences, UserPreferences } from '../services/userPreferencesApi';

interface UserPreferencesContextType {
  preferences: UserPreferences;
  loading: boolean;
  updatePreferences: (prefs: Partial<UserPreferences>) => Promise<void>;
  refreshPreferences: () => Promise<void>;
}

const UserPreferencesContext = createContext<UserPreferencesContextType | undefined>(undefined);

interface UserPreferencesProviderProps {
  children: ReactNode;
  userId: number | null;
}

export const UserPreferencesProvider: React.FC<UserPreferencesProviderProps> = ({ children, userId }) => {
  const [preferences, setPreferences] = useState<UserPreferences>({
    auto_diff_review: true, // Default to enabled
  });
  const [loading, setLoading] = useState(false);

  // Fetch preferences when user logs in
  useEffect(() => {
    if (userId) {
      refreshPreferences();
    }
  }, [userId]);

  const refreshPreferences = async () => {
    setLoading(true);
    try {
      const prefs = await getUserPreferences();
      setPreferences(prefs);
    } catch (error) {
      console.error('[UserPreferencesContext] Failed to fetch preferences:', error);
    } finally {
      setLoading(false);
    }
  };

  const updatePreferencesHandler = async (updates: Partial<UserPreferences>) => {
    const updated = await updateUserPreferences(updates);
    setPreferences(updated);
  };

  return (
    <UserPreferencesContext.Provider
      value={{
        preferences,
        loading,
        updatePreferences: updatePreferencesHandler,
        refreshPreferences,
      }}
    >
      {children}
    </UserPreferencesContext.Provider>
  );
};

/**
 * Hook to access user preferences from anywhere in the app
 */
export const useUserPreferences = (): UserPreferencesContextType => {
  const context = useContext(UserPreferencesContext);
  if (!context) {
    throw new Error('useUserPreferences must be used within a UserPreferencesProvider');
  }
  return context;
};
