import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Mail, Lock, LogIn, UserPlus, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './Login.css';

// SVG Icon for Google
const GoogleIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

export default function Login() {
  const { loginWithOAuth, loginWithPassword, signup, loginAsGuest } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [isLogin, setIsLogin] = useState(true);
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const from = location.state?.from?.pathname || "/";

  const handleAuthResult = () => {
    navigate(from, { replace: true });
  };

  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      if (isLogin) {
        await loginWithPassword(email, password);
      } else {
        if (password !== passwordConfirm) {
          throw new Error("Passwords do not match");
        }
        await signup(email, password, passwordConfirm);
      }
      handleAuthResult();
    } catch (err) {
      setError(err.message || 'Authentication failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOAuth = async (provider) => {
    setError('');
    setIsLoading(true);
    try {
      await loginWithOAuth(provider);
      handleAuthResult();
    } catch (err) {
      setError(`Failed to log in with ${provider}.`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-background">
        <div className="login-blob blob-1"></div>
        <div className="login-blob blob-2"></div>
      </div>
      
      <motion.div 
        className="login-card glass-panel"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="login-header">
          <div className="login-logo-container">
            <LogIn size={32} className="login-logo-icon" />
          </div>
          <h1>{isLogin ? 'Welcome Back' : 'Create Account'}</h1>
          <p>Sign in to sync your portfolio seamlessly.</p>
        </div>

        <AnimatePresence mode="wait">
          {error && (
            <motion.div 
              className="login-error"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
            >
              <AlertCircle size={18} />
              <span>{error}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <form onSubmit={handleEmailSubmit} className="login-form">
          <div className="login-input-group">
            <Mail size={20} className="login-input-icon" />
            <input 
              type="email" 
              placeholder="Email Address" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="login-input-group">
            <Lock size={20} className="login-input-icon" />
            <input 
              type="password" 
              placeholder="Password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>

          {!isLogin && (
            <motion.div 
              className="login-input-group"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
            >
              <Lock size={20} className="login-input-icon" />
              <input 
                type="password" 
                placeholder="Confirm Password" 
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                required
                minLength={8}
              />
            </motion.div>
          )}

          <button 
            type="submit" 
            className="login-submit-btn" 
            disabled={isLoading}
          >
            {isLoading ? (
              <span className="spinner"></span>
            ) : isLogin ? (
              <>Sign In <LogIn size={18} /></>
            ) : (
              <>Sign Up <UserPlus size={18} /></>
            )}
          </button>
        </form>

        <div className="login-divider">
          <span>Or continue with</span>
        </div>

        <div className="login-oauth-grid">
          <button 
            className="oauth-btn google-btn" 
            onClick={() => handleOAuth('google')}
            disabled={isLoading}
            type="button"
          >
            <GoogleIcon />
            <span>Google</span>
          </button>
          
          <button 
            className="oauth-btn guest-btn" 
            onClick={async () => {
              await loginAsGuest();
              handleAuthResult();
            }}
            disabled={isLoading}
            type="button"
          >
            <UserPlus size={20} />
            <span>Guest</span>
          </button>
        </div>

        <div className="login-footer">
          <p>
            {isLogin ? "Don't have an account?" : "Already have an account?"}
            <button 
              type="button" 
              className="login-toggle-btn"
              onClick={() => {
                setIsLogin(!isLogin);
                setError('');
              }}
            >
              {isLogin ? "Sign up" : "Sign in"}
            </button>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
