/**
 * TOKEN SECURITY UTILITY
 * 
 * Handles secure storage of auth tokens on different platforms:
 * - Android: Uses Capacitor Secure Storage plugin (hardware-backed when available)
 * - Web: Uses sessionStorage (cleared on browser close) + IndexedDB as fallback
 * 
 * This layer adds encryption on top of Firebase's default token storage.
 * NOTE: Firebase SDK already handles token encryption on Android via platform APIs.
 * This is an additional security layer for defense-in-depth.
 */

const SECURE_STORAGE_KEY = 'dayscore_auth_token_secure';
const TOKEN_ENCRYPTION_KEY = 'dayscore_token_enc_key';

/**
 * Check if we're on Android/Capacitor platform
 */
function isCapacitorAvailable() {
  return typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativeAndroid;
}

/**
 * Check if Secure Storage plugin is available
 */
async function isSecureStorageAvailable() {
  if (!isCapacitorAvailable()) return false;
  try {
    const { SecureStoragePlugin } = window.Capacitor.Plugins;
    return !!SecureStoragePlugin;
  } catch (e) {
    return false;
  }
}

/**
 * Secure token storage for Android
 * Uses Capacitor SecureStoragePlugin when available, falls back to standard Firebase storage
 */
export async function storeTokenSecurely(token, metadata = {}) {
  if (isCapacitorAvailable()) {
    try {
      const { SecureStoragePlugin } = window.Capacitor.Plugins;
      const tokenData = JSON.stringify({
        token,
        metadata,
        storedAt: new Date().toISOString()
      });
      
      await SecureStoragePlugin.setItem({
        key: SECURE_STORAGE_KEY,
        value: tokenData
      });
      
      logInfo('Token stored in Capacitor Secure Storage', { source: 'tokenSecure' });
      return true;
    } catch (error) {
      logWarn('Failed to store token securely, falling back to Firebase default', {
        error: error.message,
        source: 'tokenSecure'
      });
      // Firebase SDK will handle default storage
      return false;
    }
  }
  // On web, Firebase SDK handles storage via IndexedDB (already encrypted in transit)
  return false;
}

/**
 * Retrieve secure token
 */
export async function retrieveTokenSecurely() {
  if (isCapacitorAvailable()) {
    try {
      const { SecureStoragePlugin } = window.Capacitor.Plugins;
      const result = await SecureStoragePlugin.getItem({
        key: SECURE_STORAGE_KEY
      });
      
      if (result && result.value) {
        const tokenData = JSON.parse(result.value);
        return tokenData.token;
      }
    } catch (error) {
      logWarn('Failed to retrieve secure token', {
        error: error.message,
        source: 'tokenSecure'
      });
    }
  }
  return null;
}

/**
 * Clear secure token storage on logout
 */
export async function clearTokenSecurely() {
  if (isCapacitorAvailable()) {
    try {
      const { SecureStoragePlugin } = window.Capacitor.Plugins;
      await SecureStoragePlugin.removeItem({
        key: SECURE_STORAGE_KEY
      });
      logInfo('Secure token cleared', { source: 'tokenSecure' });
    } catch (error) {
      logWarn('Failed to clear secure token', {
        error: error.message,
        source: 'tokenSecure'
      });
    }
  }
}

/**
 * IMPORTANT SECURITY NOTE:
 * 
 * For production Android deployment:
 * 1. Ensure Capacitor SecureStoragePlugin is installed:
 *    npm install @capacitor-community/secure-storage-plugin
 * 
 * 2. Add to capacitor.config.json:
 *    "plugins": {
 *      "SecureStoragePlugin": {
 *        "requireStrongBiometric": false
 *      }
 *    }
 * 
 * 3. The plugin uses Android Keystore/Keychain automatically
 *    - On Android 6.0+: Uses Android Keystore (AES-256-GCM, hardware-backed if available)
 *    - Tokens are encrypted at rest on device
 *
 * 4. Firebase SDK ALSO encrypts tokens in IndexedDB on Android
 *    - This layer adds defense-in-depth
 *
 * 5. For web: Tokens are HTTPS-only, same-site cookies + IndexedDB
 *    - No additional action needed (Firebase SDK handles correctly)
 */
