/**
 * SECURE FIREBASE CONFIG
 * 
 * Do not expose API key in source code.
 * For builds:
 * - Web: Inject via build process (webpack/bundler replaces __FIREBASE_API_KEY__ at build time)
 * - Android: Injected via build.gradle buildConfigField at compile time
 * 
 * This prevents decompilers from easily extracting the key.
 */

// At build time, these are replaced with actual values from environment
window.__DAYSCORE_FIREBASE_CONFIG__ = {
  apiKey: "__FIREBASE_API_KEY__",  // Replaced at build time
  authDomain: "dayscore-sync.firebaseapp.com",
  projectId: "dayscore-sync",
  storageBucket: "dayscore-sync.firebasestorage.app",
  messagingSenderId: "1042840162617",
  appId: "1:1042840162617:web:69d9a06d7f53add18758e8"
};

// Fallback: For development only, read from window if available
// This allows local testing with .env.local
if (window.__FIREBASE_API_KEY__INJECTED__) {
  window.__DAYSCORE_FIREBASE_CONFIG__.apiKey = window.__FIREBASE_API_KEY__INJECTED__;
}
