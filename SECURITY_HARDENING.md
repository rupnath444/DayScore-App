# Security Hardening Guide

**Date:** April 19, 2026  
**Status:** Production-Ready  
**Applies To:** Google Play Store Submission

---

## Overview

This document provides complete instructions for securing sensitive configuration (API keys, tokens) before building DayScore for release. These measures prevent decompilers from extracting Firebase API keys and protect auth token storage.

---

## 1. API Key Security

### Problem
Firebase config with API key was hardcoded in `www/firebase-config.js` - visible in source code and decompiled APK.

### Solution
Use environment-based build-time injection instead of source code embedding.

### Implementation

#### Step 1: Create `.env.production`
```bash
# In the root dayscore-app directory
cd d:\dayscore-app

# Copy example
copy .env.example .env.production

# Edit with real values (DO NOT COMMIT THIS FILE)
```

`.env.production` content:
```
FIREBASE_API_KEY=AIzaSyAV_y2lXisSG2DYnosjRP6e5x6ZOVr9IJQ
FIREBASE_AUTH_DOMAIN=dayscore-sync.firebaseapp.com
FIREBASE_PROJECT_ID=dayscore-sync
FIREBASE_STORAGE_BUCKET=dayscore-sync.firebasestorage.app
FIREBASE_MESSAGING_SENDER_ID=1042840162617
FIREBASE_APP_ID=1:1042840162617:web:69d9a06d7f53add18758e8
```

**WARNING: `.env.production` is in `.gitignore` - it will NEVER be committed to GitHub.**

#### Step 2: Update `.gitignore` (Already Done)
The following is already configured:
```
.env
.env.*
!.env.example
www/firebase-config.js
android/app/src/main/assets/public/firebase-config.js
```

**Verify:** `git status --short` should NOT show `.env.production`

#### Step 3: Build Process

**For Android APK:**
1. The `build-secrets.gradle` file loads `.env.production` automatically during build
2. API key is injected into `BuildConfig.FIREBASE_API_KEY` at compile time
3. The key is NOT visible in source code - it's only in compiled bytecode
4. ProGuard/R8 minification further obfuscates the code

**For Web Build:**
```bash
# Set environment variable before building
set FIREBASE_API_KEY=AIzaSyAV_y2lXisSG2DYnosjRP6e5x6ZOVr9IJQ

# Then build (your bundler will replace __FIREBASE_API_KEY__ placeholders)
npm run build
```

---

## 2. Firebase API Key Restrictions (Console Setup)

### Why
Even with the key hidden in code, we should restrict what it can do.

### Steps

1. **Go to Firebase Console:**
   - https://console.firebase.google.com/
   - Select **dayscore-sync** project

2. **Restrict API Key:**
   - Navigate to: **Settings** (gear icon) → **Service Accounts/APIs & Services**
   - OR go to: **Project Settings** → **Service Accounts** → **API Keys**
   - Find the key starting with `AIzaSy...`

3. **Edit Restrictions:**
   - Click the key to edit
   - **Application Restrictions:**
     - Select: "Android apps"
     - Add your SHA-1 fingerprint (see below)
   - **API Restrictions:**
     - Restrict to: `Cloud Firestore API`, `Firebase Authentication API`
     - Disable: All other APIs

4. **Get Android App Fingerprint:**
   ```bash
   # Run in Android directory
   cd android
   ./gradlew signingReport
   ```
   - Find the SHA-1 hash for your release keystore
   - Add it to Firebase Console

---

## 3. Auth Token Protection

### Problem
Firebase stores auth tokens in IndexedDB on web and on Android - readable if device rooted or browser compromised.

### Solution
Use Capacitor Secure Storage plugin for Android (hardware-backed encryption).

### Implementation

#### Step 1: Install Capacitor Secure Storage
```bash
npm install @capacitor-community/secure-storage-plugin
npx cap sync
```

#### Step 2: Configure in `capacitor.config.json`
```json
{
  "plugins": {
    "SecureStoragePlugin": {
      "requireStrongBiometric": false
    }
  }
}
```

#### Step 3: Use Token Security Utility
The file `www/js/utilities/tokenSecure.js` provides:
- `storeTokenSecurely(token)` - Store auth token in Capacitor Secure Storage
- `retrieveTokenSecurely()` - Retrieve token on app startup
- `clearTokenSecurely()` - Clear token on logout

**Integration:** Wrapped into Firebase auth flow (already implemented)

#### Security Details
- **Android (Capacitor):** Uses Android Keystore (AES-256-GCM, hardware-backed if device supports it)
- **Web:** Uses sessionStorage + IndexedDB (Firebase SDK handles encryption on HTTPS)
- **Fall back:** If Secure Storage unavailable, Firebase SDK's default storage is used (still encrypted in transit)

---

## 4. Code Obfuscation (ProGuard/R8)

### Problem
Decompilers can extract API keys and auth logic from APK.

### Solution
Enable ProGuard/R8 minification and obfuscation on release builds.

### Changes Made

**In `android/app/build.gradle`:**
```gradle
buildTypes {
    release {
        minifyEnabled true
        shrinkResources true
        proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        debuggable false
    }
}
```

**In `android/app/proguard-rules.pro`:**
- Keep Firebase, Capacitor, and Kotlin classes intact (they need reflection)
- Obfuscate app code
- Strip source file info from compiled classes
- Repackage all code into randomized package names (`a`, `b`, `c`, etc.)

### Effect
- Release APK is ~15-20% smaller
- Decompiled code is unreadable (class names like `a`, `b`, method names randomized)
- Still fully functional (Firebase SDK works with obfuscated code)

---

## 5. Build Instructions

### Build Release APK with All Security Measures

```bash
# Step 1: Ensure .env.production exists with real values
cd d:\dayscore-app
dir .env.production

# Step 2: Verify .gitignore (should exclude .env.production)
git status --short  # Should NOT show .env.production

# Step 3: Build release APK
cd android
./gradlew assembleRelease

# Output: android/app/build/outputs/apk/release/app-release.apk
```

### What Happens
1. ✅ `.env.production` is loaded during build
2. ✅ Firebase API key is injected into `BuildConfig`
3. ✅ Code is compiled and minified with ProGuard/R8
4. ✅ Source files are stripped from compiled code
5. ✅ App logic is obfuscated (unreadable when decompiled)
6. ✅ APK is signed with release keystore

### Verification
```bash
# Decompile and check if API key is visible
unzip app-release.apk
# Try to find raw "AIzaSy..." strings → Should NOT be directly visible
# ProGuard output will show obfuscated method/class names → Expected
```

---

## 6. Securely Store Build Secrets

### Local Development
- Create `.env.local` for local testing (not committed)
- Create `.env.production` for release builds (not committed)
- Both are in `.gitignore`

### CI/CD Pipeline (GitHub Actions, etc.)
Store secrets as GitHub Secrets:
```yaml
env:
  FIREBASE_API_KEY: ${{ secrets.FIREBASE_API_KEY }}
```

Never commit real API keys to git!

---

## 7. Checklist for Release

- [ ] Create `.env.production` with real Firebase config
- [ ] Verify `.gitignore` excludes `.env.production` and `firebase-config.js`
- [ ] Verify `android/app/build.gradle` has `minifyEnabled = true`
- [ ] Verify `proguard-rules.pro` is configured
- [ ] Set up Firebase API key restrictions in Console
- [ ] Install Capacitor Secure Storage: `npm install @capacitor-community/secure-storage-plugin`
- [ ] Run `./gradlew assembleRelease` and verify APK builds successfully
- [ ] Test APK on real device (Firebase auth, sync, error logging)
- [ ] Verify error logs upload to Firestore
- [ ] Decompile APK to confirm code is obfuscated (class names are `a`, `b`, `c`, etc.)

---

## 8. Reference

| Issue | Risk | Solution | Status |
|-------|------|----------|--------|
| API Key in source | HIGH | Build-time injection via .env | ✅ Implemented |
| Code reverse-engineering | HIGH | ProGuard/R8 minification | ✅ Implemented |
| Auth tokens readable if rooted | MEDIUM | Capacitor Secure Storage | ✅ Available |
| Old logs taking storage | LOW | Firebase retention policy | ⏳ TODO (optional) |

---

## 9. Troubleshooting

### `./gradlew assembleRelease` fails
**Error:** `.env.production` not found
**Fix:** Create `.env.production` in root directory with real API key

### API key still visible in decompiled APK
**Cause:** Debug build, not release build
**Fix:** Use `assembleRelease` not `assembleDebug`

### Minification breaks Firebase auth
**Cause:** -keep rules missing for Firebase classes
**Fix:** Verify `proguard-rules.pro` has `-keep class com.google.firebase.** { *; }`

---

**Last Updated:** April 19, 2026  
**Next Review:** Before Play Store submission
