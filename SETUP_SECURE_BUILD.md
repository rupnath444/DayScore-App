# Setup Instructions for Secure Builds

## Quick Start

Follow these steps to prepare DayScore for Google Play Store submission with security hardening enabled.

### Step 1: Create Environment Configuration

```bash
# From the root workspace directory
cd d:\dayscore-app

# Copy the example template
copy .env.example .env.production

# Open .env.production in VS Code and update with REAL values
# (The API key you'll replace is already correct - this is just for reference)
#
# FIREBASE_API_KEY=AIzaSyAV_y2lXisSG2DYnosjRP6e5x6ZOVr9IJQ
# FIREBASE_AUTH_DOMAIN=dayscore-sync.firebaseapp.com
# FIREBASE_PROJECT_ID=dayscore-sync
# FIREBASE_STORAGE_BUCKET=dayscore-sync.firebasestorage.app
# FIREBASE_MESSAGING_SENDER_ID=1042840162617
# FIREBASE_APP_ID=1:1042840162617:web:69d9a06d7f53add18758e8
```

**IMPORTANT:** `.env.production` is in `.gitignore` and will NEVER appear in git history.

### Step 2: Install Secure Token Storage Plugin

```bash
# Install Capacitor Secure Storage (for encrypted auth tokens on Android)
npm install @capacitor-community/secure-storage-plugin

# If building Android, sync native code
npx cap sync android
```

### Step 3: Verify Security Files Are In Place

```bash
# Check these files exist:
# - .gitignore (excludes .env.production) ✅
# - android/build-secrets.gradle (loads .env.production) ✅
# - www/firebase-config-secure.js (template for API key injection) ✅
# - www/js/utilities/tokenSecure.js (Capacitor token storage) ✅
# - android/app/build.gradle (minifyEnabled = true) ✅
# - android/app/proguard-rules.pro (obfuscation rules) ✅
# - SECURITY_HARDENING.md (complete guide) ✅ 

git status --short
```

### Step 4: Build Release APK

```bash
cd android

# Build release APK with all security measures applied
./gradlew assembleRelease

# Output: app/build/outputs/apk/release/app-release.apk
```

**What this does:**
- Loads `.env.production` automatically
- Injects Firebase API key into compiled code (NOT visible in source)
- Minifies and obfuscates all code with ProGuard/R8
- Strips debug symbols
- Disables debuggable flag

### Step 5: Test on Real Device

```bash
# Install APK on test device
adb install -r android/app/build/outputs/apk/release/app-release.apk

# Test:
# 1. Sign in (triggers auto-login to Firebase)
# 2. Create a task (tests sync)
# 3. Enable Airplane mode → create/edit task → check error logs in Firestore
# 4. Verify logs appear in Firestore under users/{uid}/errorLogs
```

### Step 6: Security Verification (Optional but Recommended)

```bash
# Decompile the APK to verify obfuscation
unzip android/app/build/outputs/apk/release/app-release.apk -d apk-decompiled

# Check AndroidManifest.xml (should NOT have android:debuggable="true")
cat apk-decompiled/AndroidManifest.xml | grep debuggable

# Expected: No debuggable="true" (or debuggable="false")

# Decompiled classes will have names like: com.a.b.c, com.b.c.d
# Original class names are NOT visible (security benefit)
```

### Step 7: Firebase API Key Restrictions (In Console)

1. Go to https://console.firebase.google.com/
2. Select **dayscore-sync** project
3. **Project Settings** → **APIs & Services** → **API Keys**
4. Edit your Firebase Web API Key
5. Set:
   - **Application Restrictions:** Android app + your key fingerprint
   - **API Restrictions:** Firestore, Firebase Auth only

See [SECURITY_HARDENING.md](./SECURITY_HARDENING.md) for detailed steps.

### Step 8: Commit to GitHub

```bash
git add .
git status --short  # Verify .env.production is NOT listed
git commit -m "Add security hardening: API key injection, ProGuard, token encryption"
git push origin main
```

---

## FAQ

**Q: Where is my API key stored?**
A: In `.env.production` which is NOT committed to git. It's only used at build time to inject the key into the compiled APK.

**Q: What if my API key is compromised?**
A: 
1. Regenerate it in Firebase Console
2. Update `.env.production` with new key
3. Rebuild APK with `./gradlew assembleRelease`
4. Set API key restrictions to your app only

**Q: Why minify the APK?**
A: Makes reverse-engineering harder. Decompiled code shows obfuscated names like `a`, `b`, `c` instead of readable class names.

**Q: Can I still debug release APK?**
A: Limited debugging (crash logs still work). For debugging: build with `./gradlew assembleDebug` (minifyEnabled=false, debuggable=true).

**Q: Do I need to install Capacitor Secure Storage?**
A: Yes, for Android. It encrypts auth tokens at rest (hardware-backed if device supports it).

---

## Cleanup (After Successful Build)

```bash
# Remove old/generated files
rm -r android/app/build/
rm -r android/build/

# Keep .env.production (don't delete - needed for next build)
```

---

**Next Step:** Build and test on real device, then submit to Play Store!
