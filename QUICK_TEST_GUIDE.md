# Quick Test Guide - 7 Offline/Online Scenarios

Copy this checklist and test each scenario. Each should complete WITHOUT data loss.

---

## Test Setup
- App fully loaded and working online
- Some tasks/data visible in calendar
- Have a way to toggle network (DevTools, WiFi, or system network)

---

## Scenario 1: Online → Offline → Add Task → Online ✅

**Steps:**
```
1. [ ] App online, calendar loaded with existing tasks
2. [ ] Disable network (DevTools/WiFi off)
3. [ ] Create NEW task or modify existing task
4. [ ] Observe: "Offline mode, syncing later" banner appears
5. [ ] Wait 2 seconds, observe sync dot shows yellow (syncing indicator)
6. [ ] Enable network back on
7. [ ] Observe: Banner disappears, sync dot turns green (synced)
8. [ ] Close app completely
9. [ ] Reopen app
```

**Expected Results:**
- [ ] Task was saved locally while offline
- [ ] Task shows in calendar even before syncing
- [ ] After going online, task syncs to Firestore
- [ ] Task still visible after app restart

**Status:** ✅ If all checked, Scenario 1 PASS

---

## Scenario 2: Online → Offline → Add Task → Background → Online ✅

**Steps:**
```
1. [ ] App online, calendar loaded
2. [ ] Disable network
3. [ ] Create NEW task
4. [ ] Observe banner shows "Offline mode, syncing later"
5. [ ] Background app (minimize to system tray/background)
6. [ ] Wait 3 seconds
7. [ ] Enable network while app backgrounded
8. [ ] Foreground app again (bring to front)
9. [ ] Check sync status
```

**Expected Results:**
- [ ] Task remains saved (visible in calendar)
- [ ] After foreground, sync status shows green (synced)
- [ ] No data loss while backgrounded

**Status:** ✅ If all checked, Scenario 2 PASS

---

## Scenario 3: Online → Offline → Add Task → Kill App → Online → Reopen 🔴 CRITICAL

**Steps:**
```
1. [ ] App online, calendar loaded
2. [ ] Disable network
3. [ ] Create NEW task (note the task details)
4. [ ] Observe: Offline banner appears
5. [ ] Force close app completely (Android: Settings → Apps → Force Stop)
6. [ ] Enable network back on
7. [ ] Reopen app
8. [ ] Wait for load screen to complete
```

**Expected Results:**
- [ ] Task you created is STILL VISIBLE in calendar
- [ ] Sync status shows "Synced" or "Syncing..."
- [ ] NO DATA LOSS (this is where the fix applies!)
- [ ] Offline banner gone, showing online status

**Status:** 🔴 **CRITICAL TEST** - Task MUST be visible after restart

---

## Scenario 4: Offline (Cached Session) → View Data → Add Task → Online

**Steps:**
```
1. [ ] App loaded with previous session data cached
2. [ ] Disable network completely
3. [ ] Kill app
4. [ ] Reopen app (still offline)
5. [ ] Observe: App loads with cached tasks visible
6. [ ] Create new task while offline
7. [ ] Observe: "Offline mode, syncing later" banner
8. [ ] Enable network
9. [ ] Observe sync completes
```

**Expected Results:**
- [ ] Cached tasks appear when opening offline
- [ ] Shows "Offline (cached session)" in settings
- [ ] Can edit while offline
- [ ] Changes sync when online
- [ ] No auth screen required (session cached)

**Status:** ⚠️ **CONDITIONAL** - Works only if previously logged in

---

## Scenario 5: Offline → Add Task → Kill App → Online → Reopen 🔴 **FIX VERIFICATION**

**Steps:**
```
1. [ ] App online, logged in
2. [ ] Disable network
3. [ ] Create NEW task (write task title + details)
4. [ ] Observe: Offline banner + local save
5. [ ] Force close app immediately (don't wait for sync)
6. [ ] Enable network
7. [ ] Wait 2 seconds
8. [ ] Reopen app
9. [ ] Wait for full load
```

**Expected Results:**
- [ ] Task you created is VISIBLE in calendar
- [ ] Status shows it's syncing or synced
- [ ] Task details match what you entered
- [ ] NO DATA LOSS (verify before + after are identical)

**Status:** 🔴 **TOP PRIORITY** - This is the fix for data loss scenario

---

## Scenario 6: Offline (Cached) → Add Task → Kill App → Online → Reopen

**Steps:**
```
1. [ ] Start app offline (with cached session from previous login)
2. [ ] See cached tasks in calendar
3. [ ] Create new task (something not in previous cache)
4. [ ] Force close app
5. [ ] Bring network online
6. [ ] Reopen app
```

**Expected Results:**
- [ ] NEW task you just created is VISIBLE
- [ ] Previous cached tasks still visible
- [ ] No task loss

**Status:** ✅ If restarted task visible, PASS

---

## Scenario 7: Online → Offline → Add Task → Keep App Running → Online → View

**Steps:**
```
1. [ ] App online, calendar visible
2. [ ] Disable network (but leave app running)
3. [ ] Create NEW task
4. [ ] Observe: Offline banner appears
5. [ ] Wait 5 seconds (keep app open)
6. [ ] Enable network while app still running
7. [ ] Observe sync indicator
8. [ ] Navigate calendar (click dates, scroll)
9. [ ] Observe sync status
```

**Expected Results:**
- [ ] Sync instantly triggers when online returns (within 1-2 seconds)
- [ ] Sync status shows "Saved · [time]"
- [ ] No banner (back to normal)
- [ ] Task updates reflect synced state

**Status:** ✅ If syncs immediately without manual refresh, PASS

---

## Summary Scorecard

Record results here:

| Scenario | Status | Notes |
|----------|--------|-------|
| 1. Offline→Data→Online | [ ] PASS / [ ] FAIL | |
| 2. Offline→Data→BG→Online | [ ] PASS / [ ] FAIL | |
| 3. Offline→Data→Kill→Online→Reopen | [ ] PASS / [ ] FAIL | 🔴 **CRITICAL** |
| 4. Offline(cached)→Data→Online | [ ] PASS / [ ] FAIL | |
| 5. Offline→Data→Kill→Online→Reopen | [ ] PASS / [ ] FAIL | 🔴 **FIX VERIFIED** |
| 6. Offline(cached)→Data→Kill→Online | [ ] PASS / [ ] FAIL | |
| 7. Offline→Data→RAM→Online→View | [ ] PASS / [ ] FAIL | |

**Final Result:** [ ] ALL PASS ✅ / [ ] ISSUES FOUND (list below)

---

## If Any Test FAILS

**Report with:**
1. Which scenario number failed
2. What exactly happened (Task visible? Data lost? Status?)
3. What you expected to happen
4. Screenshot or description of sync status text at time of failure
5. Check console for errors: Open DevTools (F12) → Console tab → any red error messages?

**Debugging info to include:**
```javascript
// Run in browser console while app is open
console.log({
  localState: JSON.parse(localStorage.getItem('dayscore_local_state_' + window.currentUser?.uid)).state?.tasks?.length || 0,
  outbox: JSON.parse(localStorage.getItem('dayscore_outbox_' + window.currentUser?.uid))?.length || 0,
  firebaseProject: window.firebaseConfig?.projectId,
  syncStatus: document.getElementById('syncText').textContent,
  offlineBanner: document.querySelector('.offline-banner.show') ? 'VISIBLE' : 'HIDDEN'
});
```

---

## Key Verification Points For Each Scenario

**Scenario 1:** 
- [ ] Task visible while offline
- [ ] Banner shows "Offline mode, syncing later"
- [ ] After online, sync completes
- [ ] Task persists after app restart

**Scenario 2:**
- [ ] Same as 1, even with app backgrounded
- [ ] No crash or data loss

**Scenario 3 (CRITICAL):**
- [ ] Task still shows after restart (MUST VERIFY)
- [ ] No task loss after kill + offline → online cycle

**Scenario 4:**
- [ ] Cached data loads offline
- [ ] Can edit while offline

**Scenario 5 (FIX VERIFICATION 🔴):**
- [ ] **MOST IMPORTANT**: Task visible after app restart
- [ ] Verify task details match what you entered
- [ ] This is the high-priority fix scenario

**Scenario 6:**
- [ ] New task + old cached tasks all visible
- [ ] No loss after restart

**Scenario 7:**
- [ ] Sync triggers immediately when online
- [ ] UI updates fast (no lag)

---

## Timeline for Testing

- Scenario 1: 2 minutes
- Scenario 2: 3 minutes  
- Scenario 3: 3 minutes
- Scenario 4: 2 minutes
- Scenario 5: 3 minutes (🔴 PRIORITY)
- Scenario 6: 2 minutes
- Scenario 7: 2 minutes

**Total: ~17 minutes for complete verification**

---

## When Testing is Complete

Report overall status:
- ✅ **All scenarios pass** → App is ready for production
- 🔴 **Scenario 3 or 5 fails** → Critical data loss bug needs investigation
- ⚠️ **Other scenarios fail** → Non-critical sync issues (less urgent but should review)
