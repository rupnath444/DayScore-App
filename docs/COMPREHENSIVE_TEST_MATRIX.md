# DayScore: Comprehensive Offline/Online Test Matrix
## Every Scenario & Edge Case to Test

---

## Category 1: Basic Network State Transitions

### 1.1 Online → Offline → Online (No Data Changed)
**Steps:**
1. Auth: Logged in ✓
2. App: Running in foreground
3. Data: None added
4. Action: Toggle offline → online
5. Check: UI updates, no errors, no false syncs

**Expected:** ✅ UI updates, "Offline mode" shown briefly, then clears

**Code Path:** `window.addEventListener('offline')` → `setOfflineBanner(true)`

---

### 1.2 Online → Offline → Online (Data Added)
**Steps:**
1. Auth: Logged in
2. Online, add task
3. While queued to sync, go offline
4. Go back online
5. Verify sync completes

**Expected:** ✅ Data stays queued, syncs when online resumes

**Edge Case:** Sync in-progress when offline triggered

---

### 1.3 Offline → Online → Offline → Online (Multiple Cycles)
**Steps:**
1. Add task while offline
2. Go online (wait for sync)
3. Go offline again
4. Add another task
5. Go online

**Expected:** ✅ Both tasks eventually sync, outbox clears properly

---

### 1.4 Rapid Online/Offline Toggle
**Steps:**
1. Toggle offline → online → offline → online (5 times in 10 seconds)
2. Add task during toggles
3. Settle to online
4. Check data

**Expected:** ✅ No crashes, data queued once, syncs when settled online

**Risk:** Race conditions in sync logic

---

## Category 2: App Lifecycle + Network States

### 2.1 Sync In-Progress → Kill App
**Steps:**
1. Add task (large data to make sync take longer)
2. Go online, sync starts
3. While syncing, force close app
4. Reopen app

**Expected:** ✅ Sync resumes from where it left off or retries

---

### 2.2 App Background → Network Changes → Foreground
**Sub: Offline → Foreground → Still Offline**
**Steps:**
1. Add task offline
2. Background app
3. While backgrounded: no network change
4. Foreground app
5. Check status

**Expected:** ✅ Banner still shows "Offline mode", task still in outbox

---

### 2.3 App Background → Network Changes → Foreground
**Sub: Offline → Foreground → Network Online**
**Steps:**
1. Add task offline
2. Background app (sync timer paused)
3. While backgrounded: turn network on
4. Foreground app
5. Sync should trigger

**Expected:** ✅ Online event fires → sync starts even though app was backgrounded

**Risk:** Browser throttles timers in background

---

### 2.4 Cold Start Offline
**Steps:**
1. Force close app (clear RAM)
2. Disable network
3. Reopen app
4. Check if previous data loads

**Expected:** ✅ Cached data from `LOCAL_LAST_STATE_KEY` loads

---

### 2.5 Cold Start Offline → Auth Pending
**Steps:**
1. App offline on cold start
2. Waiting for Firebase IndexedDB auth restoration
3. User views calendar before auth completes
4. Auth completes (or fails)
5. Check state

**Expected:** ⚠️ May show empty or loading state briefly, then cached data or offline fallback

**Risk:** Auth timing vs. cache loading race condition

---

### 2.6 Cold Start Online → Immediately Go Offline
**Steps:**
1. Force close app completely
2. Reopen while online
3. Before data loads completely, disable network
4. Check UI behavior

**Expected:** ✅ Continues loading from cache, no crash

---

## Category 3: Authentication States

### 3.1 Offline → Add Data → Auth Expires → Online
**Steps:**
1. Offline, add task (uses `lastKnownUid` from cache)
2. Auth token expires (time passes ~30+ min)
3. Go online
4. App tries to sync, gets auth error
5. Should re-prompt login or use refresh token

**Expected:** ⚠️ App detects auth failure, either:
- Syncs with refresh token (Firebase auto-refresh)
- Shows login screen
- Falls back to offline mode

---

### 3.2 Logged Out → Offline → Add Data → Reopen
**Steps:**
1. Delete/sign out of account
2. Go offline
3. Add task (should show error: no auth)
4. Kill app
5. Reopen app
6. Check state

**Expected:** ✅ Shows login screen, task not saved (no uid available)

---

### 3.3 Logged In → Another User Logs In → Offline → Switch Back
**Steps:**
1. User A logged in, adds task online
2. Switch to User B (login), goes offline, adds task
3. Kill app
4. Reopen, logged in as User B
5. Switch back to User A

**Expected:** ✅ Each user's data isolated, User B's offline changes stored separately

**Risk:** Multi-user cache key collision

---

### 3.4 Auth Restored from IndexedDB Persistence
**Steps:**
1. Logged in online
2. Network offline
3. Force close app
4. Reopen (still offline)
5. Check if auth restored from IndexedDB

**Expected:** ✅ Firebase IndexedDB persistence restores auth session automaticallly

---

## Category 4: Data Scenarios

### 4.1 Large Data Sync While Offline → Online
**Steps:**
1. Add 10+ tasks while offline (build up big state)
2. Go online
3. Monitor sync progress
4. Check outbox empties

**Expected:** ✅ Syncs even with large payload, respects queue limit (80 items)

---

### 4.2 Offline → Add Task → Modify Task → Online
**Steps:**
1. Offline, add task (save v1)
2. Modify task (save v2)
3. Online, verify only final version syncs

**Expected:** ✅ Outbox merges to latest state, only v2 sent to cloud

**Verification:** Check Firestore console, should have v2 timestamp

---

### 4.3 Offline → Add Task A → Add Task B → Add Task C → Online
**Steps:**
1. Offline, add 3 tasks
2. Monitor outbox (should have 3 items)
3. Go online
4. Watch sync process queue

**Expected:** ✅ Syncs all 3 tasks, empties outbox

---

### 4.4 Offline → Add Task → Clear Browser Data → Reopen
**Steps:**
1. Add task offline, not synced
2. Clear browser localStorage/IndexedDB
3. Reopen app

**Expected:** 🔴 **CRITICAL** - Task lost (this is a user error, but should handle gracefully)

**Mitigation:** App should show "No data" not crash

---

### 4.5 Offline → Add Diary Entry → Add Task → Add Note → Online
**Steps:**
1. Add multiple data types while offline
2. Go online
3. Verify all types sync

**Expected:** ✅ All data types handled by same merge logic

---

### 4.6 Offline → Add Task → Delete Task → Online
**Steps:**
1. Add task offline
2. Delete same task offline
3. Go online
4. Check Firestore: should show as deleted

**Expected:** ✅ Final state (deleted) syncs, server reflects deletion

---

## Category 5: Conflict Resolution Scenarios

### 5.1 Local Newer → Remote Newer (Timestamp Conflict)
**Steps:**
1. Edit task offline at 12:00 (local)
2. Go online, but somehow remote shows 12:05 (from another device)
3. Check merge logic

**Expected:** ✅ Remote wins only if no outbox pending

**With Fix:** ✅ Local wins if outbox has items (they're the pending changes)

---

### 5.2 Multi-Device Edit Conflict (Advanced)
**Steps:**
1. Device A: Offline, edit Task 1
2. Device B: Online, edit Task 1 to different value
3. Device A: Go online
4. Check which version survives

**Expected:** ⚠️ Timestamp comparison determines winner (oldest edit loses)

**Note:** Perfect conflict resolution requires CRDTs/operational transforms (out of scope)

---

### 5.3 Local State vs. Outbox Mismatch
**Steps:**
1. Offline, add task (saved to localStorage + outbox)
2. Corrupt outbox in DevTools (edit localStorage)
3. Go online
4. Check if app crashes or recovers

**Expected:** ✅ Should still sync (outbox or local, one of them valid)

---

## Category 6: Error Scenarios

### 6.1 Network Down → Cloud Down (Both Offline)
**Steps:**
1. Disable network
2. Offline add task
3. Enable network (but Firebase service is down)
4. App detects cloud unreachable: `checkCloudReachability()` fails
5. Check banner

**Expected:** ✅ Shows "Cloud offline, syncing later" (distinct from network offline)

---

### 6.2 Network On → Cloud Down (Network Reachable But Firebase Dead)
**Steps:**
1. Online, normal state
2. Firebase service goes down (disable in console or DDoS simulation)
3. Try to sync
4. Check error handling

**Expected:** ✅ `processOutbox()` catches error, retries with backoff

---

### 6.3 Sync Fails Mid-Upload
**Steps:**
1. Add task offline
2. Go online, sync starts
3. During `setDoc()` call, network dies
4. Check recovery

**Expected:** ✅ Exception caught, retry scheduled with exponential backoff

---

### 6.4 Invalid State Saved Locally (Corrupt Data)
**Steps:**
1. Edit localStorage to corrupt task data (make invalid JSON)
2. Open app
3. Try to load corrupted state

**Expected:** ✅ `normalizeStateShape()` handles gracefully, doesn't crash

---

### 6.5 Quota Exceeded (Storage Full)
**Steps:**
1. Fill up local storage (add huge amounts of data)
2. Try to add task
3. localStorage.setItem() fails

**Expected:** ⚠️ App should handle rejection, maybe warn user or clear old sync logs

---

### 6.6 Auth Token Refresh Fails
**Steps:**
1. Offline, add task with `lastKnownUid`
2. Go online, actual auth cannot refresh (expired)
3. Firebase refresh token also invalid
4. Sync attempts

**Expected:** ✅ Auth state fires (no current user), shows login screen

---

## Category 7: Sync Queue Edge Cases

### 7.1 Outbox Queue Exceeds Limit (80 Items)
**Steps:**
1. Offline, keep adding tasks: 85+ tasks
2. Check outbox queue size

**Expected:** ✅ Queue capped at 80 items (oldest discarded)

**Code Check:** `writeOutbox()` uses `queue.slice(-LOCAL_QUEUE_LIMIT)`

---

### 7.2 Outbox Item Fails, Others Succeed
**Steps:**
1. Queue 3 items in outbox
2. Go online, first syncs OK
3. Second item fails due to validation error
4. Check third item behavior

**Expected:** ⚠️ Current implementation:
- First item synced, shifted from queue
- Second item still at front, will retry next attempt
- Item won't be skipped, prevents data loss

---

### 7.3 Sync Log Exceeds Retention (120 Items)
**Steps:**
1. Many offline cycles, generate 150+ sync log entries
2. Check sync log size

**Expected:** ✅ Log capped at 120 entries (oldest removed)

**Code Check:** `appendSyncLog()` uses `slice(-LOCAL_SYNC_LOG_LIMIT)`

---

### 7.4 Empty Outbox → Return Early from processOutbox
**Steps:**
1. Offline, add task, queue it
2. Sync completes, outbox cleared
3. Another sync attempt triggered (online event fires again)
4. Check behavior with empty queue

**Expected:** ✅ Early return: `if(!queue.length) return;` prevents unnecessary work

---

## Category 8: Clock & Timing Edge Cases

### 8.1 Device Clock Behind Server (Old Timestamp)
**Steps:**
1. Set device clock to 1 hour ago
2. Add task offline
3. Set clock back to current
4. Go online, merge logic compares timestamps

**Expected:** ⚠️ Local timestamp < server timestamp
- Without fix: Remote wins incorrectly
- With fix: Outbox check prevents loss ✅

---

### 8.2 Device Clock Ahead of Server
**Steps:**
1. Set device clock to 1 hour in future
2. Add task offline (gets future timestamp)
3. Set clock back
4. Go online

**Expected:** ✅ Local timestamp > server, merge prefers local (correct)

---

### 8.3 Very Rapid Edits (Sub-second)
**Steps:**
1. Offline, edit task 5 times in 2 seconds
2. Each edit calls `persist()` → `scheduleSave(700ms)`
3. Check outbox after 3 seconds

**Expected:** ✅ Multiple edits merged into single outbox item (debouncing works)

---

### 8.4 Sync Throttle: 5-Second Cache on Cloud Check
**Steps:**
1. Go offline, add task
2. Try to sync, `checkCloudReachability()` called at T=0, fails
3. At T=2s, try sync again
4. Should use cached result (not make new server call)

**Expected:** ✅ Respects 5-second throttle: `if(!force && (now - lastCloudCheckAt) < 5000) return cloudReachable;`

---

## Category 9: UI & UX Scenarios

### 9.1 Offline Banner Display Lifecycle
**Steps:**
1. Go offline → banner appears
2. UI shows "Offline mode, syncing later"
3. Go online → banner disappears
4. Monitor state

**Expected:** ✅ Banner correctly shown/hidden

---

### 9.2 Sync Status Text Updates
**Steps:**
1. Before sync: "Saved · [time]"
2. Start sync: "Syncing 3 pending changes..."
3. While syncing offline: "Offline mode · changes saved locally"
4. After sync: "Saved · [new time]"

**Expected:** ✅ Text reflects current state

---

### 9.3 Sync Dot Animation
**Steps:**
1. Normal state: Green dot (synced)
2. Adding task: Yellow dot (syncing)
3. Error: Red dot
4. Offline: Check dot color

**Expected:** ✅ Dot animates correctly: `.sync-dot.syncing { animation: pulse 1s infinite; }`

---

### 9.4 Multiple Sync Status Changes Rapid Fire
**Steps:**
1. Offline, add 5 tasks
2. Go online
3. Monitor sync status text changes

**Expected:** ✅ Text updates for each queue item synced

---

## Category 10: Advanced Integration Scenarios

### 10.1 Offline → Add Reminder → Online
**Steps:**
1. Offline, create reminder for tomorrow
2. Go online
3. Check if reminder syncs + native reminder scheduled

**Expected:** ✅ Reminder data syncs + `queueReminderSync()` queued

---

### 10.2 Offline → Theme Toggle → Online
**Steps:**
1. Offline, switch dark/light theme
2. Go online
3. Check if theme preference syncs

**Expected:** ⚠️ Theme stored in localStorage (✅) but NOT synced to cloud (expected, user-only pref)

---

### 10.3 Offline → Change Settings → Online
**Steps:**
1. Offline, modify settings (notification on/off, etc.)
2. Go online
3. Check if settings sync

**Expected:** ✅ Settings saved locally, synced on online if in state object

---

### 10.4 Offline → Export Data → Reopen
**Steps:**
1. Offline, trigger export (if available)
2. Check if export works with only local cache

**Expected:** ✅ Export pulls from state (in RAM or localStorage)

---

### 10.5 Offline → Multiple Users in Shared Context → Online
**Steps:**
1. Device with app for User A (offline, adds task)
2. Device-level: somehow User B logs in
3. Check cascade

**Expected:** ✅ Each user has separate `LOCAL_STATE_PREFIX + uid`, no collision

---

## Category 11: Recovery & Fallback Paths

### 11.1 Binary: Current User vs. Last Known User
**Steps:**
1. User A signs in, offline, adds task
2. Force close
3. Reopen, auth fails (offline), fallback to `lastKnownUid`

**Expected:** ✅ Uses `lastKnownUid` from localStorage to recover

---

### 11.2 Fallback Priority: Per-User vs. Global Snapshot
**Steps:**
1. Add task (saves to per-user cache + global fallback)
2. Corrupt per-user cache entry (delete from DevTools)
3. Cold start offline
4. Check if global fallback loads

**Expected:** ✅ Falls back to `LOCAL_LAST_STATE_KEY` when per-user missing

---

### 11.3 All Caches Empty → Cold Start
**Steps:**
1. New installation (no prior data)
2. Go offline immediately
3. Reopen app

**Expected:** ✅ Shows login screen (auth required) or empty state

---

### 11.4 Corrupted Global Fallback
**Steps:**
1. Edit localStorage `LOCAL_LAST_STATE_KEY` to invalid JSON
2. Cold start offline
3. Check if app crashes

**Expected:** ✅ `try/catch` in `readLastLocalState()` prevents crash

---

## Category 12: Specific Scenario Combinations (High-Risk)

### 12.1 🔴 **HIGH PRIORITY: The Data Loss Scenario (Already Fixed)**
**Steps:**
1. Offline, add task
2. Kill app (sync timer cleared)
3. Cloud somehow has newer remote state (timestamp-wise)
4. Reopen app online
5. Merge logic runs

**Without Fix:** ❌ Remote overwrites local → data loss
**With Fix:** ✅ Outbox check prevents loss

---

### 12.2 🔴 **Auth Restoration Race**
**Steps:**
1. Offline, add task using `lastKnownUid`
2. Kill app
3. Reopen online, both IndexedDB auth AND lastKnownUid available
4. Check which takes priority

**Expected:** ✅ `currentUser` from IndexedDB auth takes priority, same uid

---

### 12.3 Sync Success Partial (Some Items, Not Others)
**Steps:**
1. Queue 3 items
2. First syncs OK
3. Second fails
4. Check if third is attempted

**Expected:** ⚠️ Current code: Stops at first failure, retries all later
- This prevents out-of-order issues ✅

---

### 12.4 Network Change Mid-Sync
**Steps:**
1. Online, syncing item 1
2. Mid-`setDoc()`, network drops
3. Exception caught, retry scheduled
4. Network comes back
5. Auto-retry from backoff timer

**Expected:** ✅ Exponential backoff handles eventual reconnect

---

### 12.5 🔴 **Rapid Add → Delete → Add (Debounce Test)**
**Steps:**
1. Offline
2. Add task (T=0)
3. Delete task (T=100ms)
4. Add different task (T=200ms)
5. Check outbox at T=1s

**Expected:** ✅ Single outbox item with final state (add only)

---

## Category 13: Browser/Platform Specific

### 13.1 PWA Install + Offline
**Steps:**
1. Install as PWA
2. Go offline
3. Open PWA
4. Same offline test

**Expected:** ✅ Should work (same localStorage/IndexedDB access)

---

### 13.2 iCloud+ Sync (iOS App)
**Steps:**
1. iOS Capacitor app
2. iCloud data sync enabled
3. Go offline
4. Add data
5. Switch to online

**Expected:** ⚠️ May have cross-sync conflicts (app + iCloud)

---

### 13.3 Windows Background Task Standby
**Steps:**
1. Offline, add task
2. Windows puts app in standby (low power)
3. Network comes back
4. App resumes

**Expected:** ⚠️ May not trigger online event if CPU suspended too deeply
**Mitigation:** App should re-check sync on foreground

---

## Testing Priority Matrix

| Priority | Category | Reason |
|----------|----------|--------|
| 🔴 P0 | 12.1 - Data Loss Scenario | Already fixed, must verify |
| 🔴 P0 | 4.4 - Clear Data | Critical UX issue |
| 🔴 P0 | 5.1 - Timestamp Conflict | Can lose data |
| 🔴 P0 | 12.4 - Network Drop Mid-Sync | Real world scenario |
| 🟠 P1 | 1.1-1.4 - Basic Transitions | Foundation functionality |
| 🟠 P1 | 2.1-2.6 - App Lifecycle | Core feature |
| 🟠 P1 | 3.1-3.4 - Auth States | Critical for multi-user |
| 🟠 P1 | 4.1-4.6 - Data Scenarios | Common use cases |
| 🟠 P1 | 6.1-6.6 - Error Handling | Reliability |
| 🟡 P2 | 7.1-7.4 - Queue Edge Cases | Performance/stability |
| 🟡 P2 | 8.1-8.4 - Timing Edge Cases | Clock manipulation unlikely |
| 🟡 P2 | 9.1-9.4 - UI/UX | Visual feedback |
| 🟢 P3 | 10.1-10.5 - Integration | Feature-specific |
| 🟢 P3 | 11.1-11.4 - Recovery Paths | Fallback coverage |
| 🟢 P3 | 13.1-13.3 - Platform Specific | Platform-dependent |

---

## Summary: Test Execution Plan

**Phase 1 (Critical - 30 min):**
- [ ] 12.1 - Data Loss Scenario (VERIFY FIX WORKS)
- [ ] 1.1, 1.2, 1.3 - Basic online/offline transitions
- [ ] 2.4, 2.5 - Cold start scenarios
- [ ] 4.4 - Clear browser data
- [ ] 6.1, 6.2 - Network/Cloud Down scenarios

**Phase 2 (Important - 45 min):**
- [ ] 2.1-2.3 - App lifecycle + network
- [ ] 3.1-3.4 - Auth scenarios
- [ ] 4.1-4.3 - Data scenarios
- [ ] 5.1 - Timestamp conflict
- [ ] 7.1 - Queue size limit

**Phase 2.5 (Product Signal Tasks - between core and extended):**
- [ ] Add "Need web version?" prompt in Settings + subtle dashboard CTA, then track events: shown / yes / no / dismissed (collect for 4-6 weeks)
- [ ] Add future "Support DayScore" ad tile task, but keep it disabled until growth threshold is reached (example: >= 1,000 MAU and stable retention)

**Phase 3 (Extended - 30 min):**
- [ ] 8.x - Timing scenarios
- [ ] 9.x - UI/UX verification
- [ ] 10.x - Integration scenarios
- [ ] 11.x - Recovery fallbacks
- [ ] 12.2-12.5 - Advanced combinations

**Phase 4 (Optional - Platform specific):**
- [ ] 13.x - PWA, iOS, Windows tests

---

## Quick Reference: Each Test Answers

| Test ID | Answers Question |
|---------|------------------|
| 1.x | Does network state change handling work? |
| 2.x | Does app lifecycle (background, kill) + network work? |
| 3.x | Does auth (login, logout, expiry) work offline? |
| 4.x | Does data (add, modify, delete) persist offline? |
| 5.x | Does conflict resolution favor local changes correctly? |
| 6.x | Does error handling retry gracefully? |
| 7.x | Does queue management (limits, ordering) work? |
| 8.x | Does timing (clock, debounce, throttle) work? |
| 9.x | Does UI (banner, dots, text) update correctly? |
| 10.x | Do features (reminders, settings) work offline? |
| 11.x | Do fallback paths work when primary caches fail? |
| 12.x | Do complex real-world combinations work? |
| 13.x | Do platform-specific scenarios work? |
