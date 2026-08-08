import React, { createContext, useContext, useState, useEffect } from 'react';
import { pb, connectPocketBase } from '../store/sync';
import localforage from 'localforage';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(pb.authStore.model);
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    // Connect to PocketBase on mount
    connectPocketBase().catch(console.warn);

    // Listen for auth changes
    const unsubscribe = pb.authStore.onChange((token, model) => {
      setUser(model);
    });
    
    setIsInitializing(false);

    return () => {
      unsubscribe();
    };
  }, []);

  const loginWithOAuth = async (providerName) => {
    try {
      const authData = await pb.collection('users').authWithOAuth2({ provider: providerName });
      return authData;
    } catch (err) {
      console.error(`OAuth login failed for ${providerName}:`, err);
      throw err;
    }
  };

  const loginWithPassword = async (email, password) => {
    try {
      const authData = await pb.collection('users').authWithPassword(email, password);
      return authData;
    } catch (err) {
      console.error('Password login failed:', err);
      throw err;
    }
  };

  const signup = async (email, password, passwordConfirm) => {
    try {
      await pb.collection('users').create({
        email,
        password,
        passwordConfirm
      });
      // Automatically log in after signup
      return await loginWithPassword(email, password);
    } catch (err) {
      console.error('Signup failed:', err);
      throw err;
    }
  };

  const loginAsGuest = async () => {
    // Clear any previous local data for the guest session
    await localforage.clear();
    setUser({ id: 'guest', email: 'Guest User', isGuest: true });
  };

  const logout = async () => {
    pb.authStore.clear();
    setUser(null);
    // Wipe local databases to prevent data leakage between users
    try {
      await localforage.clear();
      // Reload the page to reset all states globally
      window.location.href = '/login';
    } catch (err) {
      console.error('Failed to clear local data on logout:', err);
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      isInitializing,
      loginWithOAuth,
      loginWithPassword,
      signup,
      loginAsGuest,
      logout
    }}>
      {!isInitializing && children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
};
