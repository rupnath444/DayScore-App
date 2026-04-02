# DayScore Offline/Online Scenarios - Code Analysis

## Current Architecture Overview
- **Local State Storage**: `LOCAL_STATE_PREFIX + uid` (per-user cache)
- **Global Fallback**: `LOCAL_LAST_STATE_KEY` (always written regardless of uid)
- **Outbox Queue**: `LOCAL_OUTBOX_PREFIX + uid` (pending changes)
- **Trigger**: `persist()` called on every change → queues to outbox → schedules `processOutbox()`
- **Sync Flow**: `processOutbox()` → checks `navigator.onLine` → checks `checkCloudReachability()` → merges & pushes to Firestore

---

## Scenario Testing Checklist

### ✅ Scenario 1: Online → Offline → Enter Data → Online
**Steps:**
1. App online, authenticated
2. Go offline (disable network)
3. Enter/modify task data
4. Go online (enable network)

**Expected Behavior:**
- ✅ Data saved to local storage (localStorage) immediately when typed
- ✅ Outbox queue created with pending change
- ✅ "Offline mode, syncing later" banner shows
- ✅ When online again, `window.addEventListener('online')` triggers
- ✅ `scheduleOutboxWorker(150)` queued
- ✅ `processOutbox()` executes → checks `checkCloudReachability()` → pushes to Firestore
- ✅ Sync status updates to "Saved · [time]"
- ✅ Banner disappears

**Code Path:**
```
persist() → writeLocalState() + enqueueOutboxSnapshot()
→ offline event → setOfflineBanner(true) + setSyncStatus('error')
→ online event → scheduleOutboxWorker(150)
→ processOutbox() → checkCloudReachability() → setDoc() → setOfflineBanner(false)
```

**Status:** ✅ **SAFE** - Flow properly handles queuing and syncing

---

### ✅ Scenario 2: Online → Offline → Enter Data → Exit App (Keep in RAM) → Online
**Steps:**
1. App online, authenticated
2. Go offline
3. Enter/modify task data
4. Close/background app (keep in RAM, don't terminate)
5. Go online
6. Bring app to foreground

**Expected Behavior:**
- ✅ Data persisted to localStorage (in step 3)
- ✅ `processOutbox()` timer may still be active in RAM
- ✅ When online event fires → `scheduleOutboxWorker(150)`
- ✅ If timer still active, the pending sync executes
- ✅ Data syncs to cloud

**Code Path:**
```
persist() → writeLocalState() immediately
→ offline event listeners remain active
→ online event fires → scheduleOutboxWorker(150) schedules next processOutbox()
→ processOutbox() executes from timer
```

**Potential Issue:** ⚠️ **MINOR**
- If app is backgrounded, `setInterval`/`setTimeout` may be throttled by browser
- **Mitigation**: App uses `scheduleOutboxWorker()` which queues next attempt with backoff
- **Code Safety**: ✅ Even if sync delayed, localStorage persists the change until successful

**Status:** ✅ **SAFE** - localStorage ensures data survives; online event triggers retry

---

### ⚠️ Scenario 3: Online → Offline → Enter Data → Remove from RAM → Online & Reopen
**Steps:**
1. App online, authenticated
2. Go offline
3. Enter/modify task data
4. Force close app / clear from RAM (hard kill)
5. Go online
6. Reopen app

**Expected Behavior:**
- ✅ Data persisted to localStorage (in step 3)
- ✅ `outboxWorkerTimer` destroyed (RAM cleared) but data stays in localStorage
- ✅ On app reopen → `onAuthStateChanged` fires
- ✅ `loadFromFirebase()` executes
- ✅ **Critical**: Must read both local + outbox on startup
- ✅ Should detect unsynced outbox queue and trigger sync
- ✅ Should merge/compare local vs remote state

**Code Analysis:**

Current `onAuthStateChanged()` handler:
```javascript
const local = readLocalState(user.uid);
const lastLocal = readLastLocalState(user.uid);
if(local) state = normalizeStateShape(local);
else if(lastLocal?.state) state = normalizeStateShape(lastLocal.state);

await loadFromFirebase();
```

Then `loadFromFirebase()`:
```javascript
const local = readLocalState(uid);
const fallback = readLastLocalState(uid);
const cachedState = local || fallback?.state || null;
if(cachedState){
  state = normalizeStateShape(cachedState);
}

// Later checks cloud vs local
if(remoteState && localState){
  if(stateUpdatedAt(localState) > stateUpdatedAt(remoteState)){
    state = localState;
    enqueueOutboxSnapshot(uid, state);  // Re-queues if local newer
  }
}
```

**Status:** ⚠️ **POTENTIAL ISSUE - NEEDS FIX**

**Problem Identified:**
1. ✅ Per-user cache (`LOCAL_STATE_PREFIX + uid`) correctly loads
2. ✅ Global fallback correctly loads as backup
3. ✅ `loadFromFirebase()` compares timestamps correctly
4. ❌ **MISSING**: After app startup from RAM-clear, the **existing outbox queue** is not checked/restored

**What's Missing:**
- `processOutbox()` is scheduled AFTER `loadFromFirebase()` completes (line: `scheduleOutboxWorker(150)`)
- BUT if outbox already has items from step 3, they should be re-synced
- Current code does handle this: `onAuthStateChanged` → `await loadFromFirebase()` → `scheduleOutboxWorker(150)`
- The outbox is read fresh on each `processOutbox()` call: `const queue = readOutbox(uid);`

**Status After Review:** ✅ **ACTUALLY SAFE**
- Outbox queue is read fresh from localStorage on each sync attempt
- Initial state load (per-user + fallback) is separate from outbox
- `scheduleOutboxWorker(150)` called after auth completes, ensuring queued items sync

---

### ⚠️ Scenario 4: Offline → Check Data → Add/Change Data → Online
**Steps:**
1. Start offline (no network)
2. View existing data (from previous cold-start load)
3. Add new task / modify existing task
4. Go online

**Expected Behavior:**
- ✅ Offline mode detected on startup (no auth)
- ✅ `onAuthStateChanged` fallback branch executes
- ✅ Cached state loaded from `readLastLocalState()` or `readLocalState()`
- ✅ Data displayed to user
- ✅ User can edit (within offline mode)
- ✅ Changes saved to local state + outbox
- ✅ When online → sync triggers

**Code Path:**
```
onAuthStateChanged (user=null) → offlineMode=true
→ readLocalState() || readLastLocalState()
→ UI shows cached data
→ persist() on edit → writeLocalState() + enqueueOutboxSnapshot()
→ offline banner shows
→ online event → processOutbox() → checkCloudReachability() → setDoc()
```

**Status:** ⚠️ **CONDITIONAL**

**Issue 1: Offline Mode Without Auth**
- Current code at line 1138:
```javascript
if(!explicitSignOut && lastKnownUid){
  const local = readLocalState(lastKnownUid);
  const fallback = readLastLocalState(lastKnownUid);
  const cachedState = local || fallback?.state || null;
  if(cachedState){
    offlineMode = true;
    // ... shows UI
  }
}
```
- ✅ This works IF `lastKnownUid` exists from previous session
- ❓ **Question**: What if user never signed in before? (New user, offline-first)
- **Answer**: User goes to login screen, cannot proceed without auth

**Issue 2: Editing in Offline Mode**
- When `offlineMode = true` and `currentUser = null`:
  - `persist()` calls `getActiveUidForLocal()` → returns `lastKnownUid`
  - ✅ Outbox created with `lastKnownUid`
  - When online → `checkCloudReachability(lastKnownUid)` called
  - ✅ Should work correctly

**Status:** ✅ **SAFE** for returning users, ⚠️ **NEEDS AUTH** for cold-start

---

### ⚠️ Scenario 5: Offline → Change Data → Leave App → Online
**Steps:**
1. Start offline
2. Edit data
3. Background/close app (with or without RAM clear)
4. Go online
5. Reopen app

**Expected Behavior:**
- ⚠️ **Two sub-cases:**

**Sub-case 5A: App in RAM (backgrounded only)**
- ✅ `processOutbox()` timer may trigger when online event fires
- ✅ Pending changes sync immediately

**Sub-case 5B: App killed/RAM cleared**
- ✅ localStorage persists the change + outbox
- ✅ On reopen: `onAuthStateChanged` → tries to re-auth
- ❌ **ISSUE**: If still offline when app reopens, AND user data in Firebase ≠ cached data
  - Current code: `loadFromFirebase()` with cloud unavailable
  - Falls back to `cachedState`
  - But if auth somehow succeeds (cached token?), it will compare timestamps
  - If local newer: `enqueueOutboxSnapshot()` re-adds to queue → handled
  - If remote newer: overwrites with remote → **loses local changes!**

**Problematic Code at line 1205-1212:**
```javascript
if(remoteState && localState){
  if(stateUpdatedAt(localState) > stateUpdatedAt(remoteState)){
    state = localState;
    enqueueOutboxSnapshot(uid, state);  // ✅ Re-adds to queue
  } else {
    state = remoteState;  // ❌ OVERWRITES if remote is newer!
  }
}
```

**Status:** ⚠️ **POTENTIAL DATA LOSS**

**Severity:** 🔴 **HIGH** - If remote is newer than local, local changes discarded

**How This Happens:**
1. User edits offline at 12:00 (local state, queued)
2. App killed
3. User goes online and reopens
4. Auth succeeds (cached Firebase token)
5. Remote still shows old data (from before edit)
6. BUT if somehow remote timestamp > local (clock skew?), remote wins
7. **Local changes lost**

**Required Fix:**
- When `currentUser` exists BUT app was offline when edited:
  - Should trust outbox queue over direct timestamp comparison
  - OR always prefer local if outbox has items

---

### ⚠️ Scenario 6: Offline → Enter Data → Remove from RAM → Online → Reopen
**Steps:**
1. Start offline with cached session
2. Edit data (saved to localStorage + outbox)
3. Force close app (hard kill, RAM cleared)
4. Go online
5. Reopen app

**Expected Behavior:**
- ✅ App restarts, auth state recovered from IndexedDB
- ✅ `onAuthStateChanged` fires with `user` (Firebase session restored)
- ✅ Per-user cache/outbox loaded from localStorage
- ✅ `loadFromFirebase()` executes
- ✅ LOCAL state should sync to remote (outbox processed + timestamp comparison)

**Code Analysis:**
- ✅ Firebase IndexedDB persistence restores auth session
- ✅ `onAuthStateChanged(user)` branch executes
- ✅ `loadFromFirebase()` compares local vs remote
- ✅ If local newer, `enqueueOutboxSnapshot()` re-queues
- ✅ `scheduleOutboxWorker(150)` triggers sync

**Status:** ✅ **SAFE** - IndexedDB persistence ensures session recovery + timestamp logic handles merge

---

### ⚠️ Scenario 7: Online → Offline → Enter Data → Keep in RAM → Online → Check Updated
**Steps:**
1. App online, authenticated
2. Go offline
3. Enter/modify data
4. Leave app running (in RAM, online again)
5. Go online (within app or browser detects)
6. Navigate app to view data

**Expected Behavior:**
- ✅ Offline mode enters, data queued
- ✅ When online detected (step 5):
  - `window.addEventListener('online')` fires
  - `scheduleOutboxWorker(150)` queued
  - `processOutbox()` executes
  - `checkCloudReachability(uid)` → passes (now online)
  - `setDoc()` pushes to Firestore
  - ✅ Remote updated
- ✅ When user navigates, UI reflects synced state

**Status:** ✅ **SAFE** - Online event listener triggers sync immediately

---

## Summary of Issues Found

| Scenario | Status | Issue | Severity | Fix Required |
|----------|--------|-------|----------|--------------|
| 1. Online→Offline→Data→Online | ✅ Safe | None | - | No |
| 2. Online→Offline→Data→BGed→Online | ✅ Safe | Timer throttled (minor) | 🟡 Low | No (mitigated by localStorage) |
| 3. Online→Offline→Data→Killed→Online | ✅ Safe | Outbox restored on startup | - | No |
| 4. Offline→View→Add→Online | ⚠️ Conditional | Needs prior auth | 🟡 Medium | Document limitation |
| 5. Offline→Change→Exit→Online | ⚠️ Issue | Timestamp comparison can lose data | 🔴 High | **FIX NEEDED** |
| 6. Offline→Data→Killed→Online→Reopen | ✅ Safe | IndexedDB restores session | - | No |
| 7. Online→Offline→Data→RAM→Online→View | ✅ Safe | Online event triggers sync | - | No |

---

## Recommended Fixes

### Fix #1: Prevent Data Loss in Scenario 5/6 (Timestamp Comparison)

**Current Problematic Code (line 1205-1212):**
```javascript
if(remoteState && localState){
  if(stateUpdatedAt(localState) > stateUpdatedAt(remoteState)){
    state = localState;
    enqueueOutboxSnapshot(uid, state);
  } else {
    state = remoteState;  // ❌ Can lose changes
  }
}
```

**Proposed Fix:**
```javascript
if(remoteState && localState){
  // If outbox has pending items, always trust local (offline edits exist)
  if(readOutbox(uid).length > 0){
    state = localState;
    enqueueOutboxSnapshot(uid, state);
    appendSyncLog(uid, 'info', 'local-preferred-outbox-exists');
  } else if(stateUpdatedAt(localState) > stateUpdatedAt(remoteState)){
    state = localState;
    enqueueOutboxSnapshot(uid, state);
  } else {
    state = remoteState;
  }
}
```

**Rationale:**
- If outbox queue has items, it means offline edits that haven't synced yet
- Those edits are intentional user changes and take priority
- This prevents remote data (which may be stale from before offline period) from overwriting pending changes

---

## Test Plan for User Verification

Run through each scenario and verify:

```
Scenario 1: Online→Offline→Data→Online
[ ] Data entered while offline saves locally
[ ] "Offline mode, syncing later" banner appears
[ ] When online, data syncs to Firestore (verify in console)
[ ] Banner disappears, shows "Saved · [time]"

Scenario 2: Online→Offline→Data→Background→Online
[ ] Same as scenario 1, but app backgrounded during sync
[ ] On reopening, data should still be synced

Scenario 3: Online→Offline→Data→Kill→Online→Reopen
[ ] Data remains in local storage after kill
[ ] On reopen (online), data syncs automatically
[ ] No data loss

Scenario 4: Offline→View→Add→Online
[ ] Starting offline shows previous cached data
[ ] Can edit while offline
[ ] Changes sync when online

Scenario 5: Offline→Change→Exit→Online (🔴 HIGH PRIORITY)
[ ] Make change offline
[ ] Exit app completely
[ ] Go online
[ ] Reopen app
[ ] ✅ VERIFY: Local changes are NOT lost
[ ] ✅ VERIFY: Changes sync to Firestore

Scenario 6: Offline→Data→Kill→Online→Reopen (Critical)
[ ] Offline, make change
[ ] Kill app (force close)
[ ] Go online
[ ] Reopen app
[ ] ✅ VERIFY: Data visible and synced

Scenario 7: Online→Offline→Data→RAM→Online→View
[ ] Make change offline (app stays in RAM)
[ ] Go online
[ ] Navigate app
[ ] ✅ VERIFY: Data reflected as synced
```

---

## Additional Recommendations

1. **Add Outbox Check to Merge Logic**: Implement Fix #1 above
2. **Test IndexedDB Auth Persistence**: Confirm Firebase session token survives app restart
3. **Add Sync Log Viewer**: Help debug sync issues with timestamp/state history
4. **Test Clock Skew**: Verify behavior if device clock is behind server
5. **Monitor Outbox Size**: Ensure 80-item limit prevents queue explosion

---

## Code Changes Needed

**File:** `d:\dayscore-app\www\index.html`

**Location:** In `loadFromFirebase()` function, around line 1205

**Change:** Add outbox check before discarding local state as "remote is newer"
