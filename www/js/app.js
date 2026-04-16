import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider,
  signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut,
  onAuthStateChanged, setPersistence, indexedDBLocalPersistence,
  browserLocalPersistence, inMemoryPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocFromServer, setDoc, enableIndexedDbPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { EXPECTED_PROJECT_ID, PROJECT_MARKER_KEY, firebaseConfig } from './config/firebase-config.js';
import {
  THEME_KEY,
  CF_KEY,
  LOCAL_LAST_UID_KEY,
  LOCAL_STATE_PREFIX,
  LOCAL_LAST_STATE_KEY,
  LOCAL_OUTBOX_PREFIX,
  LOCAL_SYNCLOG_PREFIX,
  LOCAL_QUEUE_LIMIT,
  LOCAL_SYNC_LOG_LIMIT,
  REMINDER_TRACKED_IDS_KEY,
  REMINDER_TRACKED_PAYLOADS_KEY,
  REMINDER_OVERDUE_MARKS_KEY,
  REMINDER_CHANNEL_ID,
  LEGACY_REMINDER_CHANNEL_ID,
  REMINDER_ACTION_TYPE_ID,
  REMINDER_SNOOZE_MINUTES,
  POMO_END_KEY,
  POMO_REMAINING_KEY,
  POMO_RUNNING_KEY,
  POMO_DURATION_KEY
} from './config/constants.js';
import { logDiag } from './diagnostics/debugPanel.js';

// ── SINGLE FIREBASE CONFIG — used everywhere ───────────────────
if(firebaseConfig.projectId !== EXPECTED_PROJECT_ID){
  throw new Error('Firebase project mismatch. Expected dayscore-sync.');
}

const fbApp   = initializeApp(firebaseConfig);
const auth    = getAuth(fbApp);
const db      = getFirestore(fbApp);
const provider = new GoogleAuthProvider();

// If app was previously pointed at another project, clear session once.
const prevProject = localStorage.getItem(PROJECT_MARKER_KEY);
if(prevProject && prevProject !== firebaseConfig.projectId){
  try { await signOut(auth); } catch(e) {}
}
localStorage.setItem(PROJECT_MARKER_KEY, firebaseConfig.projectId);

// Prefer durable auth persistence, but gracefully fall back if WebView blocks IndexedDB.
try {
  await setPersistence(auth, indexedDBLocalPersistence);
} catch (idbErr) {
  console.warn('Auth IndexedDB persistence unavailable, falling back to local persistence:', idbErr);
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (localErr) {
    console.warn('Auth local persistence unavailable, falling back to memory persistence:', localErr);
    await setPersistence(auth, inMemoryPersistence);
  }
}

// Firestore offline cache
try { await enableIndexedDbPersistence(db); } catch(e) {}

// Detect platform
const isAndroid = /Android/i.test(navigator.userAgent);
const isNative  = typeof window.Capacitor !== 'undefined';
// Android device builds only.
const IS_RELEASE_BUILD = isAndroid && isNative;

// ── STATE ──────────────────────────────────────────────────────

let state = { tasks:{}, notes:{}, threshold:50, utility:{goalTarget:'2027-02-01',goalName:'Days until GATE 2027',goalNote:'',pomoMinutes:25}, diary:{}, updatedAt:0 };
let currentUser = null;
let saveTimer   = null;
let reminderSyncTimer = null;
let reminderListenerBound = false;
let reminderChannelReady = false;
let reminderExactAllowed = true;
const REMINDER_RECENT_CATCHUP_MS = 2 * 60 * 1000;
let editingTimeTaskIndex = null;
let pomoTimer = null;
let diarySaveTimer = null;
let goalNoteSaveTimer = null;
let outboxWorkerTimer = null;
let syncRetryCount = 0;
let explicitSignOut = false;
let offlineMode = false;
let lastForegroundRefreshAt = 0;
let lastKnownUid = localStorage.getItem(LOCAL_LAST_UID_KEY)||'';
let cloudReachable = true;
let lastCloudCheckAt = 0;

function getThreshold(){ return (state.threshold||50)/100; }

function nowTs(){ return Date.now(); }
function stateUpdatedAt(s){ return Number(s?.updatedAt||0); }
function getActiveUidForLocal(){ return currentUser?.uid || lastKnownUid || ''; }
function localStateKey(uid){ return `${LOCAL_STATE_PREFIX}${uid}`; }
function localOutboxKey(uid){ return `${LOCAL_OUTBOX_PREFIX}${uid}`; }
function localSyncLogKey(uid){ return `${LOCAL_SYNCLOG_PREFIX}${uid}`; }
function snapshotState(){ return JSON.parse(JSON.stringify(state)); }

function setOfflineBanner(show, msg='Offline mode, syncing later'){
  const el = document.getElementById('offlineBanner');
  if(!el) return;
  el.textContent = msg;
  el.classList.toggle('show', !!show);
}

function normalizeStateShape(raw){
  const base = {tasks:{},notes:{},threshold:50,utility:{goalTarget:'2027-02-01',goalName:'Days until GATE 2027',goalNote:'',pomoMinutes:25},diary:{},diaryEntries:{},updatedAt:0};
  const merged = Object.assign(base, raw||{});
  if(!merged.utility||typeof merged.utility!=='object') merged.utility={goalTarget:'2027-02-01',goalName:'Days until GATE 2027',goalNote:'',pomoMinutes:25};
  if(!merged.tasks||typeof merged.tasks!=='object') merged.tasks={};
  if(!merged.notes||typeof merged.notes!=='object') merged.notes={};
  if(!merged.diary||typeof merged.diary!=='object') merged.diary={};
  if(!merged.diaryEntries||typeof merged.diaryEntries!=='object') merged.diaryEntries={};
  if(!merged.utility.goalTarget) merged.utility.goalTarget='2027-02-01';
  if(!merged.utility.goalName) merged.utility.goalName='Days until GATE 2027';
  if(typeof merged.utility.goalNote!=='string') merged.utility.goalNote='';
  if(!merged.utility.pomoMinutes||merged.utility.pomoMinutes<1) merged.utility.pomoMinutes=25;
  merged.updatedAt = stateUpdatedAt(merged);
  return merged;
}

function writeLocalState(uid, sourceState){
  const normalized = normalizeStateShape(sourceState);
  const savedAt = nowTs();
  if(uid){
    localStorage.setItem(localStateKey(uid), JSON.stringify({state:normalized, savedAt}));
  }
  localStorage.setItem(LOCAL_LAST_STATE_KEY, JSON.stringify({uid:uid||'', state:normalized, savedAt}));
}

function readLocalState(uid){
  if(!uid) return null;
  try{
    const raw = localStorage.getItem(localStateKey(uid));
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    return normalizeStateShape(parsed?.state||null);
  }catch(_e){
    return null;
  }
}

function readLastLocalState(preferredUid=''){
  try{
    const raw = localStorage.getItem(LOCAL_LAST_STATE_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    const stateObj = normalizeStateShape(parsed?.state||null);
    const uid = String(parsed?.uid||'');
    if(preferredUid && uid && preferredUid!==uid) return null;
    return {uid, state:stateObj};
  }catch(_e){
    return null;
  }
}

function readOutbox(uid){
  if(!uid) return [];
  try{
    const raw = localStorage.getItem(localOutboxKey(uid));
    if(!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)?parsed:[];
  }catch(_e){
    return [];
  }
}

function writeOutbox(uid, queue){
  if(!uid) return;
  const safe = Array.isArray(queue)?queue.slice(-LOCAL_QUEUE_LIMIT):[];
  localStorage.setItem(localOutboxKey(uid), JSON.stringify(safe));
}

function appendSyncLog(uid, level, message){
  logDiag(level, message, { uid: uid || '' });
  if(!uid) return;
  try{
    const raw = localStorage.getItem(localSyncLogKey(uid));
    const arr = raw?JSON.parse(raw):[];
    const next = Array.isArray(arr)?arr:[];
    next.push({ts:nowTs(),level,message});
    localStorage.setItem(localSyncLogKey(uid), JSON.stringify(next.slice(-LOCAL_SYNC_LOG_LIMIT)));
  }catch(_e){}
}

function enqueueOutboxSnapshot(uid, sourceState){
  if(!uid) return;
  const queue = readOutbox(uid);
  const payload = normalizeStateShape(sourceState);
  const item = {id:`${nowTs()}-${Math.floor(Math.random()*1000)}`, updatedAt:stateUpdatedAt(payload), state:payload};
  const last = queue[queue.length-1];
  if(last && nowTs() - Number(last?.updatedAt||0) < 1200){
    queue[queue.length-1] = item;
  } else {
    queue.push(item);
  }
  writeOutbox(uid, queue);
}

function getBackoffDelayMs(attempt){
  const base = 1200;
  const max = 60000;
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempt)));
  const jitter = 0.7 + Math.random()*0.6;
  return Math.floor(exp * jitter);
}

function scheduleOutboxWorker(delayMs=0){
  clearTimeout(outboxWorkerTimer);
  outboxWorkerTimer = setTimeout(()=>{ processOutbox().catch(()=>{}); }, Math.max(0, delayMs));
}

async function checkCloudReachability(uid, force=false){
  if(!uid||!currentUser) return false;
  const now = nowTs();
  if(!force && (now - lastCloudCheckAt) < 5000) return cloudReachable;
  lastCloudCheckAt = now;
  try{
    await getDocFromServer(doc(db,'users',uid));
    cloudReachable = true;
    return true;
  }catch(_e){
    cloudReachable = false;
    return false;
  }
}

async function processOutbox(){
  const uid = getActiveUidForLocal();
  if(!uid) return;
  const queue = readOutbox(uid);
  if(!queue.length){
    syncRetryCount = 0;
    if(!offlineMode && navigator.onLine) setOfflineBanner(false);
    return;
  }

  if(!navigator.onLine){
    setOfflineBanner(true,'Offline mode, syncing later');
    setSyncStatus('error','Offline mode · changes saved locally');
    scheduleOutboxWorker(getBackoffDelayMs(syncRetryCount++));
    return;
  }

  if(!currentUser){
    setOfflineBanner(true,'Offline mode (auth unavailable), syncing later');
    setSyncStatus('error','Auth unavailable · changes saved locally');
    scheduleOutboxWorker(getBackoffDelayMs(syncRetryCount++));
    return;
  }

  const cloudOk = await checkCloudReachability(uid, syncRetryCount>0);
  if(!cloudOk){
    appendSyncLog(uid,'error','cloud-unreachable');
    setOfflineBanner(true,'Cloud offline, syncing later');
    setSyncStatus('error','Cloud offline · changes saved locally');
    scheduleOutboxWorker(getBackoffDelayMs(syncRetryCount++));
    return;
  }

  try{
    setSyncStatus('syncing',`Syncing ${queue.length} pending change${queue.length===1?'':'s'}...`);
    const next = queue[0];
    await setDoc(doc(db,'users',uid), next.state);
    queue.shift();
    writeOutbox(uid, queue);
    syncRetryCount = 0;
    if(queue.length){
      setOfflineBanner(true,'Syncing pending changes...');
      scheduleOutboxWorker(200);
    } else {
      setOfflineBanner(false);
      setSyncStatus('synced','Saved · '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));
    }
  }catch(e){
    appendSyncLog(uid,'error',`sync-failed:${e?.code||'unknown'}`);
    setOfflineBanner(true,'Cloud unavailable, syncing later');
    setSyncStatus('error','Cloud unavailable · changes saved locally');
    scheduleOutboxWorker(getBackoffDelayMs(syncRetryCount++));
  }
}

window.addEventListener('online',()=>{
  setOfflineBanner(false);
  scheduleOutboxWorker(150);
});
window.addEventListener('offline',()=>{
  setOfflineBanner(true,'Offline mode, syncing later');
});

// ── THEME ──────────────────────────────────────────────────────
function initTheme(){ applyTheme(localStorage.getItem(THEME_KEY)||'dark'); }
function applyTheme(t){
  document.documentElement.setAttribute('data-theme',t);
  document.getElementById('ttDark').classList.toggle('active',t==='dark');
  document.getElementById('ttLight').classList.toggle('active',t==='light');
  localStorage.setItem(THEME_KEY,t);
  if(typeof renderPomodoro==='function') renderPomodoro();
}
document.getElementById('themeToggle').addEventListener('click',()=>{
  applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');
});

// ── LOGIN UI ───────────────────────────────────────────────────
function renderLoginUI(){
  const fields = document.getElementById('loginFields');
  const showGoogle = !isAndroid && !isNative;

  fields.innerHTML = `
    ${showGoogle ? `
      <button class="google-btn" id="googleSignInBtn">
        <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google">
        Continue with Google
      </button>
      <div class="auth-divider">or use email</div>
    ` : `<div class="login-note">Sign in with your email and password.</div>`}
    <input class="auth-input" id="emailInput" type="email" placeholder="Email address" autocomplete="email">
    <div style="position:relative;width:100%">
      <input class="auth-input" id="passwordInput" type="password" placeholder="Password (6+ chars)" style="padding-right:56px" autocomplete="current-password">
      <span id="togglePwd" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);cursor:pointer;font-size:9px;font-weight:bold;color:var(--accent);font-family:'DM Mono',monospace">SHOW</span>
    </div>
    <button class="auth-btn" id="emailSignInBtn">Sign In</button>
    <button class="auth-btn secondary" id="emailRegisterBtn">Create Account</button>
    <div class="login-note">All devices use the same account and data.<br>Project: dayscore-sync</div>
  `;

  document.getElementById('togglePwd').onclick = () => {
    const p = document.getElementById('passwordInput');
    p.type = p.type === 'password' ? 'text' : 'password';
    document.getElementById('togglePwd').textContent = p.type === 'password' ? 'SHOW' : 'HIDE';
  };

  if(showGoogle) document.getElementById('googleSignInBtn').onclick = googleSignIn;
  document.getElementById('emailSignInBtn').onclick = emailSignIn;
  document.getElementById('emailRegisterBtn').onclick = emailRegister;
}

// ── AUTH FUNCTIONS ─────────────────────────────────────────────
async function googleSignIn(){
  try {
    await signInWithPopup(auth, provider);
  } catch(e){
    console.error('Google sign in:', e.code);
    alert('Google sign in failed. Please use email/password.');
  }
}

async function emailSignIn(){
  const email    = document.getElementById('emailInput')?.value?.trim()?.toLowerCase();
  const password = document.getElementById('passwordInput')?.value;
  if(!email||!password){ alert('Please enter both email and password.'); return; }
  try {
    setSyncStatus('syncing','Signing in…');
    await signInWithEmailAndPassword(auth, email, password);
  } catch(e){
    console.error('Email sign in:', e.code);
    setSyncStatus('error','Sign in failed');
    if(e.code==='auth/user-not-found'||e.code==='auth/invalid-credential'||e.code==='auth/wrong-password'){
      alert('No account found with this email. Please create an account first using "Create Account".');
    } else if(e.code==='auth/invalid-api-key'){
      alert('Config mismatch detected (invalid API key). Please rebuild Android after sync and make sure all clients use dayscore-sync.');
    } else if(e.code==='auth/network-request-failed'){
      alert('Network error. Check internet and try again.');
    } else if(e.code==='auth/invalid-email'){
      alert('Please enter a valid email address.');
    } else if(e.code==='auth/too-many-requests'){
      alert('Too many failed attempts. Please wait a few minutes and try again.');
    } else {
      alert('Sign in failed: '+e.code);
    }
  }
}

async function emailRegister(){
  const email    = document.getElementById('emailInput')?.value?.trim()?.toLowerCase();
  const password = document.getElementById('passwordInput')?.value;
  if(!email||!password){ alert('Please enter email and password.'); return; }
  if(password.length<6){ alert('Password must be at least 6 characters.'); return; }
  try {
    await createUserWithEmailAndPassword(auth, email, password);
  } catch(e){
    if(e.code==='auth/email-already-in-use'){
      alert('An account with this email already exists. Please sign in instead.');
    } else {
      alert('Registration failed: '+e.code);
    }
  }
}

document.getElementById('signOutBtn').addEventListener('click', async ()=>{
  if(confirm('Sign out of DayScore?')){
    explicitSignOut = true;
    offlineMode = false;
    lastKnownUid = '';
    localStorage.removeItem(LOCAL_LAST_UID_KEY);
    await clearNativeReminderTracking();
    await signOut(auth);
  }
});

// ── AUTH STATE ─────────────────────────────────────────────────
onAuthStateChanged(auth, async (user)=>{
  const loading = document.getElementById('loadingScreen');
  const login   = document.getElementById('loginScreen');
  const main    = document.getElementById('mainApp');

  if(user){
    explicitSignOut = false;
    offlineMode = false;
    currentUser = user;
    lastKnownUid = user.uid;
    localStorage.setItem(LOCAL_LAST_UID_KEY, user.uid);
    document.getElementById('loadingSub').textContent = 'loading your data…';
    document.getElementById('settingsUserEmail').textContent = user.email || 'No email';
    setSyncStatus('syncing',`Connected to ${firebaseConfig.projectId} · loading data…`);

    const local = readLocalState(user.uid);
    const lastLocal = readLastLocalState(user.uid);
    if(local) state = normalizeStateShape(local);
    else if(lastLocal?.state) state = normalizeStateShape(lastLocal.state);

    await loadFromFirebase();
    updateSettingsUI();
    renderCalendar();
    checkCarryForward();
    requestNotifPermission();
    queueReminderSync();
    refreshReminderDiagnostics();
    setTimeout(()=>{ requestNotifPermission(); queueReminderSync(); refreshReminderDiagnostics(); },1500);
    renderUtilityDrawer();

    loading.classList.add('hidden');
    login.classList.add('hidden');
    main.style.display = 'flex';
    setOfflineBanner(false);
    scheduleOutboxWorker(150);

  } else {
    currentUser = null;
    if(!explicitSignOut && lastKnownUid){
      const local = readLocalState(lastKnownUid);
      const fallback = readLastLocalState(lastKnownUid);
      const cachedState = local || fallback?.state || null;
      if(cachedState){
        offlineMode = true;
        state = normalizeStateShape(cachedState);
        document.getElementById('settingsUserEmail').textContent = 'Offline (cached session)';
        setSyncStatus('error','Offline mode · local data only');
        setOfflineBanner(true,'Offline mode (auth unavailable), syncing later');
        updateSettingsUI();
        renderCalendar();
        renderUtilityDrawer();
        requestNotifPermission();
        queueReminderSync();
        refreshReminderDiagnostics();
        setTimeout(()=>{ requestNotifPermission(); queueReminderSync(); refreshReminderDiagnostics(); },1500);
        loading.classList.add('hidden');
        login.classList.add('hidden');
        main.style.display = 'flex';
        return;
      }
    }

    currentUser = null;
    await clearNativeReminderTracking();
    setReminderDiag('Reminder status: sign in required');
    document.getElementById('settingsUserEmail').textContent = 'Not signed in';
    setOfflineBanner(false);
    loading.classList.add('hidden');
    login.classList.remove('hidden');
    main.style.display = 'none';
    renderLoginUI();
  }
});

// ── FIRESTORE ──────────────────────────────────────────────────
function setSyncStatus(s,t){
  document.getElementById('syncDot').className = 'sync-dot '+s;
  document.getElementById('syncText').textContent = t;
}

async function loadFromFirebase(){
  const uid = currentUser?.uid || lastKnownUid;
  if(!uid) return;
  const local = readLocalState(uid);
  const fallback = readLastLocalState(uid);
  const cachedState = local || fallback?.state || null;
  if(cachedState){
    state = normalizeStateShape(cachedState);
  }

  if(!currentUser){
    setSyncStatus('error','Offline mode · local data only');
    setOfflineBanner(true,'Offline mode, syncing later');
    return;
  }

  setSyncStatus('syncing',`Loading your data (${firebaseConfig.projectId})...`);
  try {
    const snap = await getDoc(doc(db,'users',currentUser.uid));
    const remoteState = snap.exists() ? normalizeStateShape(snap.data()) : null;
    const localState = cachedState ? normalizeStateShape(cachedState) : null;

    if(remoteState && localState){
      const outbox = readOutbox(uid);
      if(outbox.length > 0){
        state = localState;
        setOfflineBanner(true,'Recovered offline changes, syncing...');
        appendSyncLog(uid,'warn','local-priority-outbox-exists');
      } else if(stateUpdatedAt(localState) > stateUpdatedAt(remoteState)){
        state = localState;
        enqueueOutboxSnapshot(uid, state);
        setOfflineBanner(true,'Recovered local changes, syncing...');
        appendSyncLog(uid,'warn','local-newer-than-remote');
      } else {
        state = remoteState;
      }
    } else if(remoteState){
      state = remoteState;
    } else if(localState){
      state = localState;
      if(readOutbox(uid).length===0) enqueueOutboxSnapshot(uid, state);
      setOfflineBanner(true,'Using local data, sync pending');
    }

    writeLocalState(uid, state);

    if(snap.exists()){
      queueReminderSync();
      scheduleOutboxWorker(200);
      setSyncStatus('synced','Synced · '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));
    } else {
      queueReminderSync();
      scheduleOutboxWorker(200);
      setSyncStatus('synced','Ready — local-first mode active');
    }
  } catch(e){
    setSyncStatus('error','Could not load cloud data, using local');
    setOfflineBanner(true,'Cloud unavailable, using local data');
    appendSyncLog(uid,'error',`load-failed:${e?.code||'unknown'}`);
    if(cachedState){
      state = normalizeStateShape(cachedState);
    }
    console.error('Load error:',e);
  }
}

async function saveToFirebase(){
  scheduleOutboxWorker(0);
}

function scheduleSave(){ clearTimeout(saveTimer); saveTimer = setTimeout(saveToFirebase,700); }
function persist(){
  const uid = getActiveUidForLocal();
  state.updatedAt = nowTs();
  if(uid){
    writeLocalState(uid, state);
    enqueueOutboxSnapshot(uid, state);
  }
  scheduleSave();
}

// ── DATE HELPERS ───────────────────────────────────────────────
let viewYear, viewMonth;
function today(){ const d=new Date(); return {y:d.getFullYear(),m:d.getMonth(),d:d.getDate()}; }
function toKey(y,m,d){ return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
function isToday(y,m,d){ const t=today(); return t.y===y&&t.m===m&&t.d===d; }
function isPast(y,m,d){ const t=today(); return new Date(y,m,d)<new Date(t.y,t.m,t.d); }
function isFuture(y,m,d){ const t=today(); return new Date(y,m,d)>new Date(t.y,t.m,t.d); }
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEKDAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const SHORT_DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function dayStatus(key){
  const tasks=state.tasks[key];
  if(!tasks||!tasks.length) return 'empty';
  return (tasks.filter(t=>t.done).length/tasks.length)>=getThreshold()?'good':'bad';
}

function calcStreak(){
  const t=today(); let streak=0;
  if(dayStatus(toKey(t.y,t.m,t.d))==='good') streak=1;
  const d=new Date(t.y,t.m,t.d); d.setDate(d.getDate()-1);
  while(true){
    const key=toKey(d.getFullYear(),d.getMonth(),d.getDate());
    if(dayStatus(key)==='good') streak++; else break;
    d.setDate(d.getDate()-1); if(d.getFullYear()<2020) break;
  }
  return streak;
}
function applyStreakMilestones(streak){
  document.body.classList.remove('milestone-7','milestone-14','milestone-30');
  if(streak>=7) document.body.classList.add('milestone-7');
  if(streak>=14) document.body.classList.add('milestone-14');
  if(streak>=30) document.body.classList.add('milestone-30');
}
function renderStreak(){
  const s=calcStreak();
  document.getElementById('streakNum').textContent=s;
  document.getElementById('streakSub').textContent=s===0?'start today!':s===1?'keep it up!':s<7?`${s} days strong!`:`${s} days 🏆`;
  applyStreakMilestones(s);
}

function renderWeekView(){
  const host=document.getElementById('weekView');
  if(!host) return;
  const t=today(), dow=new Date(t.y,t.m,t.d).getDay();
  let html='';
  for(let i=0;i<7;i++){
    const d=new Date(t.y,t.m,t.d); d.setDate(d.getDate()-dow+i);
    const y=d.getFullYear(),m=d.getMonth(),day=d.getDate();
    const key=toKey(y,m,day), st=dayStatus(key);
    const isTod=isToday(y,m,day);
    let cls='heat-day';
    if(st==='good') cls+=' good';
    else if(st==='bad') cls+=' bad';
    if(isTod) cls+=' today';
    html+=`<div class="${cls}" title="${SHORT_DAYS[i]} ${day}" onclick="openModal('${key}')"></div>`;
  }
  host.innerHTML=html;
}

function renderCalendar(){
  normalizeFutureTaskCompletion();
  const cal=document.getElementById('calendar');
  const firstDay=new Date(viewYear,viewMonth,1).getDay();
  const dim=new Date(viewYear,viewMonth+1,0).getDate();
  document.getElementById('monthLabel').textContent=`${MONTHS[viewMonth]} ${viewYear}`;
  let html='';
  for(let i=0;i<firstDay;i++) html+=`<div class="day-tile empty-slot"></div>`;
  for(let d=1;d<=dim;d++){
    const key=toKey(viewYear,viewMonth,d);
    const tasks=state.tasks[key]||[];
    const total=tasks.length, done=tasks.filter(t=>t.done).length;
    let cls='day-tile', dot='';
    if(isToday(viewYear,viewMonth,d)) cls+=' today';
    else if(isPast(viewYear,viewMonth,d)){
      const st=dayStatus(key);
      if(total>0){cls+=st==='good'?' good-day':' bad-day';dot=`<div class="status-dot ${st==='good'?'good':'bad'}"></div>`;}
    } else cls+=' future-day';
    let pips='';
    for(let p=0;p<Math.min(total,4);p++) pips+=`<div class="task-pip ${tasks[p]?.done?'done':'undone'}"></div>`;
    html+=`<div class="${cls}" onclick="openModal('${key}')">${dot}<div class="day-num">${d}</div><div class="task-preview">${pips}</div>${total>0?`<div class="task-count">${done}/${total}</div>`:''}</div>`;
  }
  const usedCells = firstDay + dim;
  const trailingCells = (7 - (usedCells % 7)) % 7;
  for(let i=0;i<trailingCells;i++) html+=`<div class="day-tile empty-slot"></div>`;
  cal.innerHTML=html;
  renderStats(); renderStreak(); renderUtilityDrawer();
}

function renderStats(){
  const dim=new Date(viewYear,viewMonth+1,0).getDate();
  let good=0,bad=0,empty=0;
  for(let d=1;d<=dim;d++){
    const key=toKey(viewYear,viewMonth,d);
    if(!isPast(viewYear,viewMonth,d)&&!isToday(viewYear,viewMonth,d)) continue;
    const st=dayStatus(key);
    if(st==='good') good++;
    else if(st==='bad') bad++;
    else empty++;
  }
  document.getElementById('goodCount').textContent=good;
  document.getElementById('badCount').textContent=bad;
  document.getElementById('emptyCount').textContent=empty;
}
function ensureUtilityState(){
  if(!state.utility||typeof state.utility!=='object') state.utility={goalTarget:'2027-02-01',goalName:'Days until GATE 2027',goalNote:'',pomoMinutes:25};
  if(!state.utility.goalTarget) state.utility.goalTarget='2027-02-01';
  if(!state.utility.goalName) state.utility.goalName='Days until GATE 2027';
  if(typeof state.utility.goalNote!=='string') state.utility.goalNote='';
  if(!state.utility.pomoMinutes||state.utility.pomoMinutes<1) state.utility.pomoMinutes=25;
  if(!state.diary||typeof state.diary!=='object') state.diary={};
  if(!state.diaryEntries||typeof state.diaryEntries!=='object') state.diaryEntries={};
}
function getPomodoroDurationMs(){
  ensureUtilityState();
  const fromLocal=Number(localStorage.getItem(POMO_DURATION_KEY)||state.utility.pomoMinutes||25);
  const mins=Math.max(1,Math.min(1439,fromLocal));
  return mins*60*1000;
}
function formatDurationLabel(mins){
  const m=Math.max(1,Math.floor(mins||25));
  if(m<60) return `${m} min`;
  const h=Math.floor(m/60), rem=m%60;
  return rem?`${h}h ${rem}m`:`${h}h`;
}
function syncPomodoroInputs(){
  const mIn=document.getElementById('pomoMinutesInput');
  if(!mIn) return;
  const mins=Math.max(1,Math.floor(state.utility?.pomoMinutes||25));
  mIn.value=String(mins);
}
function formatMs(ms){
  const s=Math.max(0,Math.floor(ms/1000));
  const m=Math.floor(s/60), sec=s%60;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}
function getPomodoroState(){
  const running=localStorage.getItem(POMO_RUNNING_KEY)==='1';
  const end=Number(localStorage.getItem(POMO_END_KEY)||0);
  const duration=getPomodoroDurationMs();
  const storedRemain=Number(localStorage.getItem(POMO_REMAINING_KEY)||duration);
  let remaining=storedRemain;
  if(running&&end>0) remaining=Math.max(0,end-Date.now());
  return {running,end,remaining};
}
function setPomodoroState(running,end,remaining){
  localStorage.setItem(POMO_RUNNING_KEY,running?'1':'0');
  localStorage.setItem(POMO_END_KEY,String(end||0));
  localStorage.setItem(POMO_REMAINING_KEY,String(Math.max(0,remaining||0)));
}
function renderPomodoro(){
  const timeEl=document.getElementById('pomoTime');
  const ring=document.getElementById('pomoRing');
  const hint=document.getElementById('pomoHint');
  const toggle=document.getElementById('pomoToggleBtn');
  const setPanel=document.getElementById('pomoSetPanel');
  if(!timeEl||!ring) return;
  const s=getPomodoroState();
  const total=getPomodoroDurationMs();
  const pct=Math.max(0,Math.min(1,s.remaining/total));
  const deg=Math.round((1-pct)*360);
  const styles=getComputedStyle(document.documentElement);
  const fill=styles.getPropertyValue('--pomo-fill').trim()||'#8c6bff';
  const track=styles.getPropertyValue('--pomo-track').trim()||'#2a3448';
  ring.style.background=`conic-gradient(${fill} ${deg}deg,${track} ${deg}deg)`;
  timeEl.textContent=formatMs(s.remaining);
  timeEl.classList.toggle('running',s.running);
  if(toggle){
    toggle.textContent=s.running?'Pause':'Start';
    toggle.classList.toggle('primary',!s.running);
  }
  if(hint){
    if(s.running) hint.textContent=`Running ${formatDurationLabel(total/60000)}`;
    else hint.textContent=setPanel?.classList.contains('open')?'Set hours/minutes, then tap Set':`Tap clock to set (${formatDurationLabel(total/60000)})`;
  }
  if(s.running&&s.remaining===0){
    setPomodoroState(false,0,total);
    if(typeof navigator!=='undefined'&&navigator.vibrate) navigator.vibrate([20,40,20]);
  }
}
function startPomodoroTicker(){
  if(pomoTimer) clearInterval(pomoTimer);
  pomoTimer=setInterval(renderPomodoro,1000);
  renderPomodoro();
}
function startPomodoro(){
  const s=getPomodoroState();
  if(s.running) return;
  const total=getPomodoroDurationMs();
  const end=Date.now()+Math.max(1000,s.remaining||total);
  setPomodoroState(true,end,s.remaining||total);
  renderPomodoro();
}
function pausePomodoro(){
  const s=getPomodoroState();
  if(!s.running) return;
  setPomodoroState(false,0,s.remaining);
  renderPomodoro();
}
function togglePomodoro(){
  const s=getPomodoroState();
  if(s.running) pausePomodoro();
  else startPomodoro();
}
function resetPomodoro(){
  setPomodoroState(false,0,getPomodoroDurationMs());
  renderPomodoro();
}
function togglePomodoroSetPanel(){
  const panel=document.getElementById('pomoSetPanel');
  if(!panel||getPomodoroState().running) return;
  panel.classList.toggle('open');
  if(panel.classList.contains('open')) document.getElementById('pomoMinutesInput')?.focus();
  renderPomodoro();
}
function closePomodoroSetPanel(){
  const panel=document.getElementById('pomoSetPanel');
  if(!panel||!panel.classList.contains('open')) return;
  panel.classList.remove('open');
  renderPomodoro();
}
function setPomodoroDurationFromInputs(closePanel=false){
  ensureUtilityState();
  if(getPomodoroState().running) return;
  const mIn=document.getElementById('pomoMinutesInput');
  if(!mIn) return;
  const total=Math.max(1,Math.min(1439,Math.round(Number(mIn.value||25))));
  state.utility.pomoMinutes=total;
  mIn.value=String(total);
  localStorage.setItem(POMO_DURATION_KEY,String(state.utility.pomoMinutes));
  setPomodoroState(false,0,getPomodoroDurationMs());
  if(closePanel) document.getElementById('pomoSetPanel')?.classList.remove('open');
  persist();
  renderPomodoro();
}
function renderGoal(){
  ensureUtilityState();
  const input=document.getElementById('goalDateInput');
  const out=document.getElementById('goalDays');
  const nameInput=document.getElementById('goalNameInput');
  const noteInput=document.getElementById('goalNoteInput');
  const targetText=document.getElementById('goalTargetText');
  if(!input||!out) return;
  input.value=state.utility.goalTarget;
  if(nameInput&&document.activeElement!==nameInput) nameInput.value=state.utility.goalName;
  if(noteInput&&document.activeElement!==noteInput) noteInput.value=state.utility.goalNote||'';
  const target=new Date(state.utility.goalTarget+'T00:00:00');
  const now=new Date();
  const today0=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const days=Math.ceil((target-today0)/86400000);
  out.textContent=String(days);
  if(targetText){
    const opts={day:'2-digit',month:'short',year:'numeric'};
    targetText.textContent=target.toLocaleDateString(undefined,opts);
  }
}
function dateToDiaryKey(d){
  return toKey(d.getFullYear(),d.getMonth(),d.getDate());
}
function parseDiaryKey(k){
  const p=(k||'').split('-').map(Number);
  if(p.length!==3||p.some(Number.isNaN)) return null;
  return new Date(p[0],p[1]-1,p[2]);
}
function formatDiaryDate(d){
  return d.toLocaleDateString(undefined,{weekday:'short',day:'2-digit',month:'short',year:'numeric'});
}
function getDiaryContentByKey(key){
  const note=(state.diaryEntries?.[key]||'').trim();
  if(note) return note;
  const legacy=state.diary?.[key];
  if(!legacy||typeof legacy!=='object') return '';
  const parts=[legacy.win||'',legacy.change||''].map(v=>String(v).trim()).filter(Boolean);
  return parts.join('\n\n');
}
function collectDiaryEntries(){
  const keySet=new Set([...(Object.keys(state.diaryEntries||{})),...(Object.keys(state.diary||{}))]);
  const list=[...keySet].map(key=>({key,date:parseDiaryKey(key),content:getDiaryContentByKey(key)})).filter(e=>e.date&&e.content.trim());
  list.sort((a,b)=>b.date-a.date);
  return list;
}
function buildDiaryBookPages(entries){
  const pages=[];
  for(let i=0;i<entries.length;i+=2){
    pages.push(entries.slice(i,i+2));
  }
  return pages;
}
function renderDiaryTile(entry){
  if(!entry) return `<div class="diary-book-tile"><div class="diary-tile-content diary-tile-empty">This day is still unwritten...</div></div>`;
  return `<div class="diary-book-tile"><div class="diary-tile-date">${formatDiaryDate(entry.date)}</div><div class="diary-tile-content">${escHtml(entry.content)}</div></div>`;
}
function applyDiaryBookDepth(){
  const pager=document.getElementById('diaryBookPager');
  if(!pager) return;
  const spreads=[...pager.querySelectorAll('.diary-book-spread')];
  const base=pager.scrollTop/Math.max(1,pager.clientHeight);
  spreads.forEach((el,i)=>{
    const dist=Math.min(1,Math.abs(base-i));
    el.style.transform=`scale(${1-dist*0.05})`;
    el.style.opacity=String(1-dist*0.2);
  });
}
function updateDiaryBookIndicator(total,current){
  const el=document.getElementById('diaryBookIndicator');
  if(!el) return;
  if(total<=0){ el.textContent='No diary entries yet'; return; }
  el.textContent=`Page ${current+1} of ${total}`;
}
function renderDiary(){
  ensureUtilityState();
  const todayDateEl=document.getElementById('diaryTodayDate');
  const todayBodyEl=document.getElementById('diaryTodayBody');
  const title=document.getElementById('dailyEntryTitle');
  const today=new Date();
  const todayKey=dateToDiaryKey(today);
  const todayContent=getDiaryContentByKey(todayKey);
  const todayFormatted=formatDiaryDate(today);
  if(title) title.textContent=`Diary Entry of ${todayFormatted}`;
  if(todayDateEl) todayDateEl.textContent=todayFormatted;
  if(todayBodyEl){
    if(document.activeElement!==todayBodyEl) todayBodyEl.value=todayContent||'';
  }

  const pager=document.getElementById('diaryBookPager');
  if(!pager) return;
  const entries=collectDiaryEntries();
  const pages=buildDiaryBookPages(entries);
  if(!pages.length){
    pager.innerHTML='<div class="diary-book-spread"><div class="diary-book-tile"><div class="diary-tile-content diary-tile-empty">Write notes in any calendar day to build your diary.</div></div><div class="diary-book-tile"><div class="diary-tile-content diary-tile-empty">Your entries will appear here.</div></div></div>';
    updateDiaryBookIndicator(0,0);
    return;
  }
  pager.innerHTML=pages.map(p=>`<div class="diary-book-spread">${renderDiaryTile(p[0])}${renderDiaryTile(p[1]||null)}</div>`).join('');
  const idx=Math.round(pager.scrollTop/Math.max(1,pager.clientHeight));
  updateDiaryBookIndicator(pages.length,Math.max(0,Math.min(pages.length-1,idx)));
  applyDiaryBookDepth();
}
function setupUtilityDrawer(){
  const track=document.getElementById('utilityTrack');
  if(!track||track.dataset.bound==='1') return;
  track.dataset.bound='1';
  const slides=[...document.querySelectorAll('.utility-slide')];
  const maxIdx=Math.max(0,slides.length-1);
  let isDragging=false;
  let activeFrame=0;
  let dragStartX=0;
  let dragStartLeft=0;
  let dragStartAt=0;
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
  const lockTo=(idx,behavior='auto')=>{
    const target=clamp(idx,0,maxIdx);
    track.scrollTo({left:target*track.clientWidth,behavior});
    slides.forEach((s,i)=>s.classList.toggle('active',i===target));
  };
  const syncActive=()=>{
    if(activeFrame) cancelAnimationFrame(activeFrame);
    activeFrame=requestAnimationFrame(()=>{
      const idx=Math.round(track.scrollLeft/Math.max(1,track.clientWidth));
      slides.forEach((s,i)=>s.classList.toggle('active',i===idx));
    });
  };
  track.addEventListener('scroll',syncActive);
  track.addEventListener('pointerdown',e=>{
    isDragging=true;
    // Let finger movement flow first; snap only when gesture ends.
    track.style.scrollSnapType='none';
    if(track.setPointerCapture){
      try{ track.setPointerCapture(e.pointerId); }catch(_){ }
    }
    dragStartX=e.clientX;
    dragStartLeft=track.scrollLeft;
    dragStartAt=Date.now();
  });
  track.addEventListener('pointerup',e=>{
    isDragging=false;
    track.style.scrollSnapType='x mandatory';
    const width=Math.max(1,track.clientWidth);
    const startIdx=Math.round(dragStartLeft/width);
    const moved=e.clientX-dragStartX;
    const elapsed=Math.max(1,Date.now()-dragStartAt);
    const velocity=Math.abs(moved/elapsed);
    const movedFar=Math.abs(moved)>width*0.18;
    const movedFast=velocity>0.55;
    let target=Math.round(track.scrollLeft/width);
    if(movedFar||movedFast) target=startIdx+(moved<0?1:-1);
    lockTo(target,'auto');
  });
  track.addEventListener('pointercancel',()=>{
    if(isDragging){
      track.style.scrollSnapType='x mandatory';
      const idx=Math.round(track.scrollLeft/Math.max(1,track.clientWidth));
      lockTo(idx,'auto');
    }
    isDragging=false;
  });

  document.getElementById('pomoToggleBtn')?.addEventListener('click',togglePomodoro);
  document.getElementById('pomoResetBtn')?.addEventListener('click',resetPomodoro);
  document.getElementById('pomoRing')?.addEventListener('click',togglePomodoroSetPanel);
  document.getElementById('pomoSetBtn')?.addEventListener('click',()=>setPomodoroDurationFromInputs(true));
  document.getElementById('pomoMinutesInput')?.addEventListener('focus',()=>document.getElementById('pomoSetPanel')?.classList.add('open'));
  document.getElementById('pomoSetPanel')?.addEventListener('pointerdown',e=>e.stopPropagation());
  document.getElementById('pomoSetPanel')?.addEventListener('click',e=>e.stopPropagation());
  document.getElementById('pomoMinutesInput')?.addEventListener('pointerdown',e=>e.stopPropagation());
  document.addEventListener('pointerdown',e=>{
    const panel=document.getElementById('pomoSetPanel');
    const ring=document.getElementById('pomoRing');
    if(!panel||!panel.classList.contains('open')) return;
    const target=e.target;
    const clickedInsideByTarget = target instanceof Node && (panel.contains(target) || (ring?ring.contains(target):false));
    if(clickedInsideByTarget) return;

    const path=typeof e.composedPath==='function'?e.composedPath():[];
    const clickedInsideByPath=Array.isArray(path) && path.some(node=>node===panel || node===ring);
    const clickedInside=clickedInsideByPath;
    if(clickedInside) return;
    closePomodoroSetPanel();
  });

  document.getElementById('goalDateBtn')?.addEventListener('click',()=>{
    const picker=document.getElementById('goalDateInput');
    if(!picker) return;
    if(typeof picker.showPicker==='function') picker.showPicker();
    else picker.click();
  });

  document.getElementById('goalDateInput')?.addEventListener('change',e=>{
    ensureUtilityState();
    state.utility.goalTarget=e.target.value||'2027-02-01';
    persist();
    renderGoal();
  });
  document.getElementById('goalNameInput')?.addEventListener('input',e=>{
    ensureUtilityState();
    state.utility.goalName=(e.target.value||'Days until GATE 2027').slice(0,48);
    persist();
    renderGoal();
  });
  document.getElementById('goalNoteInput')?.addEventListener('input',e=>{
    ensureUtilityState();
    state.utility.goalNote=(e.target.value||'').slice(0,220);
    clearTimeout(goalNoteSaveTimer);
    goalNoteSaveTimer=setTimeout(()=>persist(),500);
  });

  document.getElementById('diaryBookBtn')?.addEventListener('click',()=>{
    openDiaryBookModal();
  });
  document.getElementById('diaryTodayBody')?.addEventListener('input',e=>{
    ensureUtilityState();
    const today=new Date();
    const todayKey=dateToDiaryKey(today);
    state.diaryEntries=state.diaryEntries||{};
    const value=(e.target.value||'').slice(0,5000).trim();
    if(value) state.diaryEntries[todayKey]=value;
    else delete state.diaryEntries[todayKey];
    clearTimeout(diarySaveTimer);
    diarySaveTimer=setTimeout(()=>{
      persist();
      renderDiary();
    },800);
  });

  document.getElementById('diaryBookPager')?.addEventListener('scroll',()=>{
    const pager=document.getElementById('diaryBookPager');
    if(!pager) return;
    const total=buildDiaryBookPages(collectDiaryEntries()).length;
    const idx=Math.round(pager.scrollTop/Math.max(1,pager.clientHeight));
    updateDiaryBookIndicator(total,Math.max(0,Math.min(Math.max(0,total-1),idx)));
    applyDiaryBookDepth();
  });
}
function renderUtilityDrawer(){
  setupUtilityDrawer();
  ensureUtilityState();
  localStorage.setItem(POMO_DURATION_KEY,String(state.utility.pomoMinutes||25));
  syncPomodoroInputs();
  renderPomodoro();
  renderGoal();
  renderDiary();
}

// ── MODAL ──────────────────────────────────────────────────────
let activeKey=null;
window.openModal=function(key){
  activeKey=key;
  const[ys,ms,ds]=key.split('-').map(Number);
  const y=ys,m=ms-1,d=ds;
  document.getElementById('modalDate').textContent=`${WEEKDAYS[new Date(y,m,d).getDay()]}, ${MONTHS[m]} ${d}`;
  document.getElementById('modalMeta').textContent=String(y);
  const badge=document.getElementById('modalBadge');
  const tasks=state.tasks[key]||[];
  if(isFuture(y,m,d)){badge.textContent='UPCOMING';badge.className='modal-status-badge badge-future';}
  else if(isToday(y,m,d)){badge.textContent='TODAY';badge.className='modal-status-badge badge-open';}
  else if(!tasks.length){badge.textContent='NO LOG';badge.className='modal-status-badge badge-open';}
  else{const st=dayStatus(key);badge.textContent=st==='good'?'GOOD DAY':'WASTED';badge.className=`modal-status-badge ${st==='good'?'badge-good':'badge-bad'}`;}
  document.getElementById('noteInput').value=(state.notes&&state.notes[key])||'';
  const diaryContent=getDiaryContentByKey(key);
  const diaryInput=document.getElementById('diaryInput');
  if(diaryInput){
    diaryInput.value=diaryContent||'';
  }
  renderTaskList();
  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('newTaskInput').focus();
};
function closeModal(){ 
  if(activeKey){
    const diaryInput=document.getElementById('diaryInput');
    if(diaryInput){
      ensureUtilityState();
      state.diaryEntries=state.diaryEntries||{};
      const content=(diaryInput.value||'').trim();
      if(content) state.diaryEntries[activeKey]=content.slice(0,1000);
      else delete state.diaryEntries[activeKey];
      persist();
    }
  }
  document.getElementById('modalOverlay').classList.remove('open'); 
  activeKey=null; 
}

function renderTaskList(){
  if(!activeKey) return;
  const tasks=state.tasks[activeKey]||[];
  const done=tasks.filter(t=>t.done).length;
  const pw=document.getElementById('progressWrap');
  if(tasks.length>0){
    const pct=Math.round((done/tasks.length)*100);
    document.getElementById('progressFill').style.width=pct+'%';
    document.getElementById('progressFill').style.background=pct>=state.threshold?'var(--green)':pct>0?'var(--yellow)':'var(--red)';
    document.getElementById('progressLabel').textContent=pct+'%';
    pw.style.display='flex';
  } else pw.style.display='none';
  const list=document.getElementById('taskList');
  const emptyMsg=document.getElementById('emptyMsg');
  if(!tasks.length){list.innerHTML='';emptyMsg.style.display='block';return;}
  emptyMsg.style.display='none';
  const now=new Date(), nowMins=now.getHours()*60+now.getMinutes();
  const[ky,km,kd]=activeKey.split('-').map(Number);
  const keyIsToday=isToday(ky,km-1,kd);
  const keyIsFuture=isFuture(ky,km-1,kd);
  list.innerHTML=tasks.map((task,i)=>{
    const doneState=!keyIsFuture&&task.done;
    const checkClass=`task-check ${doneState?'checked':''} ${keyIsFuture?'locked':''}`.trim();
    const checkAction=keyIsFuture?'showFutureLockHint()':`toggleTask(${i})`;
    const checkLabel=keyIsFuture?'LOCK':(doneState?'✓':'');
    let timeCls='task-time', timeLabel='Set reminder';
    if(task.time){const[h,min]=task.time.split(':').map(Number);timeCls+=' has-time';timeLabel=task.time;if(keyIsToday&&!doneState&&h*60+min<nowMins)timeCls+=' overdue';}
    return`<div class="task-item"><div class="${checkClass}" onclick="${checkAction}" title="${keyIsFuture?'Locked until this day starts':'Mark task complete'}">${checkLabel}</div><div class="task-text ${doneState?'done-text':''}" contenteditable="true" onblur="editTask(${i},this.textContent.trim())" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}">${escHtml(task.text)}</div><span class="${timeCls}" onclick="editTime(${i})" title="${task.time?'Edit reminder time':'Set reminder time'}">${timeLabel}</span><button class="task-del" onclick="deleteTask(${i})">×</button></div>`;
  }).join('');
}

function escHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

window.toggleTask=function(i){
  if(!activeKey||!state.tasks[activeKey]) return;
  const [y,m,d]=activeKey.split('-').map(Number);
  if(isFuture(y,m-1,d)){
    showFutureLockHint();
    return;
  }
  state.tasks[activeKey][i].done=!state.tasks[activeKey][i].done;
  queueReminderSync();
  persist(); renderTaskList(); renderCalendar(); openModal(activeKey);
  if(state.tasks[activeKey].every(t=>t.done)) launchConfetti();
};
window.showFutureLockHint=function(){
  alert('Future tasks are locked. You can add tasks now, but you can only tick them off on that date.');
};
function normalizeFutureTaskCompletion(){
  if(!state.tasks) return;
  const t=today();
  const todayDate=new Date(t.y,t.m,t.d);
  let changed=false;
  Object.keys(state.tasks).forEach(key=>{
    const [y,m,d]=key.split('-').map(Number);
    if(!y||!m||!d) return;
    const keyDate=new Date(y,m-1,d);
    if(keyDate<=todayDate) return;
    (state.tasks[key]||[]).forEach(task=>{
      if(task.done){
        task.done=false;
        changed=true;
      }
    });
  });
  if(changed){
    queueReminderSync();
    persist();
  }
}
window.deleteTask=function(i){
  if(!activeKey||!state.tasks[activeKey]) return;
  state.tasks[activeKey].splice(i,1);
  if(!state.tasks[activeKey].length) delete state.tasks[activeKey];
  queueReminderSync();
  persist(); renderTaskList(); renderCalendar(); openModal(activeKey);
};
window.editTask=function(i,text){
  if(!activeKey||!state.tasks[activeKey]) return;
  if(!text){deleteTask(i);return;}
  state.tasks[activeKey][i].text=text;
  queueReminderSync();
  persist(); renderCalendar();
};
window.editTime=function(i){
  if(!activeKey||!state.tasks[activeKey]) return;
  const picker=document.getElementById('editTaskTimePicker');
  if(!picker){
    const cur=state.tasks[activeKey][i].time||'';
    const val=prompt('Set due time (HH:MM) or blank to clear:',cur);
    if(val===null) return;
    state.tasks[activeKey][i].time=val.trim();
    queueReminderSync();
    persist(); renderTaskList();
    return;
  }
  editingTimeTaskIndex=i;
  picker.value=state.tasks[activeKey][i].time||'';
  if(typeof picker.showPicker==='function') picker.showPicker();
  else picker.click();
};

document.getElementById('addTaskBtn').addEventListener('click',()=>{
  const inp=document.getElementById('newTaskInput'), time=document.getElementById('newTaskTime').value;
  const text=inp.value.trim();
  if(!text||!activeKey) return;
  if(!state.tasks[activeKey]) state.tasks[activeKey]=[];
  state.tasks[activeKey].push({id:Date.now(),text,done:false,time:time||''});
  inp.value=''; document.getElementById('newTaskTime').value='';
  queueReminderSync();
  persist(); renderTaskList(); renderCalendar();
});
document.getElementById('newTaskInput').addEventListener('keydown',e=>{
  if(e.key==='Enter'){
    const text=e.target.value.trim(), time=document.getElementById('newTaskTime').value;
    if(!text||!activeKey) return;
    if(!state.tasks[activeKey]) state.tasks[activeKey]=[];
    state.tasks[activeKey].push({id:Date.now(),text,done:false,time:time||''});
    e.target.value=''; document.getElementById('newTaskTime').value='';
    queueReminderSync();
    persist(); renderTaskList(); renderCalendar();
  }
});
document.getElementById('noteInput').addEventListener('blur',()=>{
  if(!activeKey) return;
  if(!state.notes) state.notes={};
  const val=document.getElementById('noteInput').value.trim();
  if(val) state.notes[activeKey]=val; else delete state.notes[activeKey];
  persist(); renderCalendar();
});
document.getElementById('diaryInput').addEventListener('blur',()=>{
  if(!activeKey) return;
  ensureUtilityState();
  state.diaryEntries=state.diaryEntries||{};
  const val=(document.getElementById('diaryInput').value||'').trim();
  if(val) state.diaryEntries[activeKey]=val.slice(0,1000);
  else delete state.diaryEntries[activeKey];
  persist();
});
document.getElementById('editTaskTimePicker').addEventListener('change',e=>{
  if(editingTimeTaskIndex===null||!activeKey||!state.tasks[activeKey]) return;
  const idx=editingTimeTaskIndex;
  editingTimeTaskIndex=null;
  state.tasks[activeKey][idx].time=(e.target.value||'').trim();
  queueReminderSync();
  persist(); renderTaskList();
});

// ── CARRY FORWARD ──────────────────────────────────────────────
let cfSelected=new Set();
function checkCarryForward(){
  const t=today(), todayK=toKey(t.y,t.m,t.d);
  if(localStorage.getItem(CF_KEY)===todayK) return;
  const yest=new Date(t.y,t.m,t.d); yest.setDate(yest.getDate()-1);
  const yestK=toKey(yest.getFullYear(),yest.getMonth(),yest.getDate());
  const yestTasks=(state.tasks[yestK]||[]).filter(t=>!t.done);
  if(!yestTasks.length) return;
  cfSelected=new Set(yestTasks.map((_,i)=>i));
  document.getElementById('cfSub').textContent=`Unfinished from ${MONTHS[yest.getMonth()]} ${yest.getDate()}`;
  document.getElementById('cfList').innerHTML=yestTasks.map((task,i)=>`<div class="cf-item selected" id="cf-${i}" onclick="toggleCF(${i})"><div class="cf-item-check">✓</div><div class="cf-item-text">${escHtml(task.text)}</div></div>`).join('');
  document.getElementById('cfOverlay').classList.add('open');
  localStorage.setItem(CF_KEY,todayK);
  window._cfTasks=yestTasks;
}
window.toggleCF=function(i){ const el=document.getElementById('cf-'+i); if(cfSelected.has(i)){cfSelected.delete(i);el.classList.remove('selected');}else{cfSelected.add(i);el.classList.add('selected');} };
window.confirmCF=function(){
  const t=today(), todayK=toKey(t.y,t.m,t.d);
  if(!state.tasks[todayK]) state.tasks[todayK]=[];
  (window._cfTasks||[]).forEach((task,i)=>{ if(cfSelected.has(i)) state.tasks[todayK].push({id:Date.now()+i,text:task.text,done:false,time:task.time||''}); });
  queueReminderSync();
  persist(); renderCalendar(); closeCF();
};
window.closeCF=function(){ document.getElementById('cfOverlay').classList.remove('open'); };

// ── CONFETTI ───────────────────────────────────────────────────
function launchConfetti(){
  const canvas=document.getElementById('confetti-canvas');
  const ctx=canvas.getContext('2d');
  canvas.width=window.innerWidth; canvas.height=window.innerHeight;
  const colors=['#1fcf72','#7b6cf8','#f5c430','#e84444','#e2e2ec'];
  const pieces=Array.from({length:150},()=>({x:Math.random()*canvas.width,y:Math.random()*canvas.height-canvas.height,w:Math.random()*10+5,h:Math.random()*6+3,color:colors[Math.floor(Math.random()*colors.length)],rot:Math.random()*360,vy:Math.random()*3+2,vx:(Math.random()-.5)*2,vr:Math.random()*4-2}));
  let frame=0;
  function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);pieces.forEach(p=>{ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.rot*Math.PI/180);ctx.fillStyle=p.color;ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h);ctx.restore();p.y+=p.vy;p.x+=p.vx;p.rot+=p.vr;});frame++;if(frame<120)requestAnimationFrame(draw);else ctx.clearRect(0,0,canvas.width,canvas.height);}
  draw();
}

// ── NOTIFICATIONS ──────────────────────────────────────────────
function canUseNativeReminders(){
  const cap=window.Capacitor;
  if(!cap) return false;
  const pluginReady=!!(cap.Plugins && cap.Plugins.LocalNotifications);
  if(!pluginReady) return false;
  if(typeof cap.isNativePlatform==='function' && !cap.isNativePlatform()) return false;
  return true;
}
function getNativeReminderPlugin(){
  return window.Capacitor?.Plugins?.LocalNotifications;
}
function getDayScoreReminderPlugin(){
  return window.Capacitor?.Plugins?.DayScoreReminder;
}
function isPermissionGranted(status){
  const value=String(status?.display ?? status?.receive ?? status?.permission ?? status?.value ?? '').toLowerCase();
  return value==='granted';
}
function setReminderDiag(msg){
  const el=document.getElementById('reminderDiag');
  if(el) el.textContent=msg;
}
function setReminderReport(msg){
  const el=document.getElementById('reminderReport');
  if(!el) return;
  el.textContent=msg;
  el.style.display=msg?'block':'none';
}
function formatReminderTime(d){
  try{
    return new Intl.DateTimeFormat([], { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }).format(d);
  }catch(_e){
    return d.toLocaleString();
  }
}
async function buildReminderSurvey(){
  const cap=window.Capacitor;
  const platform=String(cap?.getPlatform?.()||'unknown');
  const pluginReady=!!(cap?.Plugins?.LocalNotifications);
  const lines=[];
  lines.push('DayScore reminder survey');
  lines.push(`platform: ${platform}`);
  lines.push(`native runtime: ${typeof cap!=='undefined'?'yes':'no'}`);
  lines.push(`plugin ready: ${pluginReady?'yes':'no'}`);

  if(!canUseNativeReminders()){
    lines.push('native reminders: unavailable in this runtime');
    return lines.join('\n');
  }

  const LocalNotifications=getNativeReminderPlugin();
  let permText='unknown';
  let exactText='unknown';
  let pendingCount='unknown';
  let pendingIds=[];
  let exactAllowed=reminderExactAllowed;
  try{
    const perm=await LocalNotifications.checkPermissions();
    permText=perm.display || perm.receive || perm.permission || perm.state || 'unknown';
  }catch(_e){}
  try{
    if(typeof LocalNotifications.checkExactNotificationSetting==='function'){
      const exactStatus=await LocalNotifications.checkExactNotificationSetting();
      exactText=String(exactStatus?.value ?? exactStatus?.exact ?? exactStatus?.exactAlarm ?? exactStatus?.enabled ?? 'unknown');
      exactAllowed=isExactSettingAllowed(exactText);
    }
  }catch(_e){}
  try{
    if(typeof LocalNotifications.getPending==='function'){
      const pending=await LocalNotifications.getPending();
      pendingIds=(pending?.notifications||[]).map(n=>Number(n?.id)).filter(Number.isFinite);
      pendingCount=String(pendingIds.length);
    }
  }catch(_e){}

  const now=Date.now();
  const desired=[];
  Object.keys(state.tasks||{}).forEach(key=>{
    (state.tasks[key]||[]).forEach(task=>{
      if(!task.time||task.done) return;
      const due=parseDueDate(key,task.time);
      if(!due) return;
      desired.push({key,task,due,dueMs:due.getTime(),id:reminderIdForTask(key,task)});
    });
  });

  const upcoming=desired
    .filter(item=>item.dueMs>now)
    .sort((a,b)=>a.dueMs-b.dueMs)
    .slice(0,5);
  const overdue=desired.filter(item=>item.dueMs<=now);
  const pendingSet=new Set(pendingIds);
  const missingFromOs=desired.filter(item=>pendingIds.length && !pendingSet.has(item.id));

  lines.push(`notification permission: ${permText}`);
  lines.push(`exact alarms: ${exactText} (${exactAllowed?'allowed':'not allowed'})`);
  lines.push(`pending OS notifications: ${pendingCount}`);
  lines.push(`tracked reminder ids: ${JSON.parse(localStorage.getItem(REMINDER_TRACKED_IDS_KEY)||'[]').length}`);
  lines.push(`timed tasks: ${desired.length}`);
  lines.push(`overdue timed tasks: ${overdue.length}`);
  lines.push(`future timed tasks: ${upcoming.length ? upcoming.length : 0}`);

  if(upcoming.length){
    lines.push('next reminders:');
    upcoming.forEach(item=>{
      const deltaMin=Math.round((item.dueMs-now)/60000);
      lines.push(`- ${item.key} | ${item.task.time} | ${item.task.text || 'Untitled'} | due ${formatReminderTime(item.due)} | in ~${deltaMin}m`);
    });
  } else {
    lines.push('next reminders: none');
  }

  if(overdue.length){
    lines.push('overdue tasks:');
    overdue.slice(0,5).forEach(item=>{
      const lateMin=Math.round((now-item.dueMs)/60000);
      lines.push(`- ${item.key} | ${item.task.time} | ${item.task.text || 'Untitled'} | late by ~${lateMin}m`);
    });
  }

  if(missingFromOs.length){
    lines.push('mismatch warning: some desired reminders are not in the OS pending queue');
    missingFromOs.slice(0,5).forEach(item=>{
      lines.push(`- missing: ${item.key} | ${item.task.time} | ${item.task.text || 'Untitled'}`);
    });
  }

  if(!desired.length){
    lines.push('note: no timed tasks found, so only test reminders would appear');
  }

  if(!reminderExactAllowed){
    lines.push('likely cause: exact alarms are not allowed for this device/app combination');
  }

  lines.push('');
  lines.push('Interpretation:');
  lines.push('- If test reminders work but task reminders do not appear in OS pending, task scheduling is failing before background delivery.');
  lines.push('- If task reminders are pending but do not show while closed, the device is likely restricting background work (battery saver / Doze / OEM control).');
  lines.push('- If task reminders are overdue and only appear when the app opens, the device is deferring alarms until foreground resume.');

  return lines.join('\n');
}
async function runReminderSurvey(){
  try{
    setReminderDiag('Running reminder survey...');
    const report=await buildReminderSurvey();
    setReminderReport(report);
    try{ await navigator.clipboard.writeText(report); }catch(_e){}
    setReminderDiag('Reminder survey ready and copied if permitted');
  }catch(e){
    console.warn('Reminder survey failed:',e);
    const message='Reminder survey failed to run';
    setReminderReport(message);
    setReminderDiag(message);
  }
}
async function refreshReminderDiagnostics(){
  const cap=window.Capacitor;
  let platform='unknown';
  try{ platform=String(cap?.getPlatform?.()||'unknown'); }catch(_e){}
  const pluginReady=!!(cap?.Plugins?.LocalNotifications);
  if(canUseNativeReminders()){
    try{
      const LocalNotifications=getNativeReminderPlugin();
      const perm=await LocalNotifications.checkPermissions();
      let exact='n/a';
      if(typeof LocalNotifications.checkExactNotificationSetting==='function'){
        try{
          const exactStatus=await LocalNotifications.checkExactNotificationSetting();
          exact=String(exactStatus?.value ?? exactStatus?.exact ?? exactStatus?.exactAlarm ?? exactStatus?.enabled ?? 'unknown');
          reminderExactAllowed=isExactSettingAllowed(exact);
        }catch(_e){}
      }
      const reliability=reminderExactAllowed?'background: reliable':'background: limited (enable exact alarms)';
      setReminderDiag(`Native reminders: ${perm.display || perm.receive || perm.permission || 'unknown'} | exact: ${exact} | ${reliability} | platform: ${platform}`);
    }catch(e){
      setReminderDiag('Native reminders: error reading status');
    }
    return;
  }
  const hasCap=typeof cap!=='undefined';
  if(!hasCap){
    setReminderDiag('Native runtime not ready yet');
    return;
  }
  setReminderDiag(`Native reminders unavailable (plugin: ${pluginReady?'ready':'missing'}, platform: ${platform})`);
}
async function initNativeReminderListeners(){
  if(reminderListenerBound||!canUseNativeReminders()) return;
  const LocalNotifications=getNativeReminderPlugin();
  if(!LocalNotifications||typeof LocalNotifications.addListener!=='function') return;
  await LocalNotifications.addListener('localNotificationReceived',()=>{
    setReminderDiag('Last test: notification received by device');
  });
  await LocalNotifications.addListener('localNotificationActionPerformed',event=>{
    handleNativeReminderAction(event).catch(e=>console.warn('Reminder action handling failed:',e));
  });
  reminderListenerBound=true;
}
function isExactSettingAllowed(setting){
  if(setting===undefined||setting===null) return true;
  if(typeof setting==='boolean') return setting;
  if(typeof setting==='string'){
    const raw=setting.toLowerCase().trim();
    if(['granted','allowed','enabled','exact','on','true','1','not_supported','unsupported','unavailable','unknown','n/a','na'].includes(raw)) return true;
    if(['denied','disabled','off','false','0','not_allowed','not_granted','exact_alarm_denied'].includes(raw)) return false;
    if(raw.includes('deny')||raw.includes('disable')||raw.includes('not_allowed')||raw.includes('not granted')) return false;
    if(raw.includes('allow')||raw.includes('grant')||raw.includes('enable')) return true;
    return true;
  }
  return true;
}
async function ensureNativeReminderReady(showAlertOnFailure=false){
  if(!canUseNativeReminders()) return false;
  try{
    const LocalNotifications=getNativeReminderPlugin();
    let status=await LocalNotifications.checkPermissions();
    if(!isPermissionGranted(status)) status=await LocalNotifications.requestPermissions();
    if(!isPermissionGranted(status)){
      if(showAlertOnFailure) alert('Notifications are blocked for DayScore. Please allow notifications in Android settings.');
      return false;
    }

    if(typeof LocalNotifications.checkExactNotificationSetting==='function'){
      try{
        const exactStatus=await LocalNotifications.checkExactNotificationSetting();
        const exactValue=exactStatus?.value ?? exactStatus?.exact ?? exactStatus?.exactAlarm ?? exactStatus?.enabled;
        reminderExactAllowed=isExactSettingAllowed(exactValue);
        if(!isExactSettingAllowed(exactValue) && typeof LocalNotifications.changeExactNotificationSetting==='function'){
          await LocalNotifications.changeExactNotificationSetting();
          try{
            const afterChange=await LocalNotifications.checkExactNotificationSetting();
            const afterValue=afterChange?.value ?? afterChange?.exact ?? afterChange?.exactAlarm ?? afterChange?.enabled;
            reminderExactAllowed=isExactSettingAllowed(afterValue);
          }catch(_e){}
        }
      }catch(_e){}
    }

    if(!reminderChannelReady && typeof LocalNotifications.createChannel==='function'){
      try{ if(typeof LocalNotifications.deleteChannel==='function') await LocalNotifications.deleteChannel({id:LEGACY_REMINDER_CHANNEL_ID}); }catch(_e){}
      try{ if(typeof LocalNotifications.deleteChannel==='function') await LocalNotifications.deleteChannel({id:REMINDER_CHANNEL_ID}); }catch(_e){}
      await LocalNotifications.createChannel({
        id:REMINDER_CHANNEL_ID,
        name:'DayScore Reminders',
        description:'Task due reminders',
        importance:4,
        visibility:1,
        vibration:true,
        sound:'default'
      });
      reminderChannelReady=true;
    }

    if(typeof LocalNotifications.registerActionTypes==='function'){
      await LocalNotifications.registerActionTypes({
        types:[{
          id:REMINDER_ACTION_TYPE_ID,
          actions:[
            {id:'done',title:'Mark Done'},
            {id:'snooze',title:`Snooze ${REMINDER_SNOOZE_MINUTES}m`}
          ]
        }]
      });
    }
    await initNativeReminderListeners();
    await refreshReminderDiagnostics();
    if(!reminderExactAllowed && showAlertOnFailure){
      alert('Exact alarms are disabled. Task reminders may arrive late while app is closed. Please allow Exact alarms for DayScore in Android settings.');
    }
    return true;
  }catch(e){
    console.warn('Native reminder permission/setup failed:',e);
    setReminderDiag('Native reminders: setup failed');
    if(showAlertOnFailure) alert('Could not enable reminders on this device. Please check app notification settings.');
    return false;
  }
}
function hashText(s){
  let h=0;
  for(let i=0;i<s.length;i++) h=((h<<5)-h)+s.charCodeAt(i);
  return Math.abs(h);
}
function reminderIdForTask(key,task){
  return (hashText(`${key}:${task.id}`)%2000000000)+1;
}
function hmFromDate(d){
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function keyFromDate(d){
  return toKey(d.getFullYear(),d.getMonth(),d.getDate());
}
function findTaskByNotification(notification){
  const extra=notification?.extra||{};
  const extraKey=extra.taskKey;
  const extraTaskId=Number(extra.taskId);
  if(extraKey&&Number.isFinite(extraTaskId)&&state.tasks[extraKey]){
    const idx=state.tasks[extraKey].findIndex(t=>Number(t.id)===extraTaskId);
    if(idx>=0) return {key:extraKey,index:idx,task:state.tasks[extraKey][idx]};
  }
  const nid=Number(notification?.id);
  if(!Number.isFinite(nid)) return null;
  for(const key of Object.keys(state.tasks||{})){
    const tasks=state.tasks[key]||[];
    for(let i=0;i<tasks.length;i++){
      if(reminderIdForTask(key,tasks[i])===nid) return {key,index:i,task:tasks[i]};
    }
  }
  return null;
}
async function handleNativeReminderAction(event){
  const actionId=String(event?.actionId||'').toLowerCase();
  if(!actionId||actionId==='tap') return;
  const hit=findTaskByNotification(event?.notification);
  if(!hit) return;

  if(actionId==='done'){
    if(!hit.task.done){
      hit.task.done=true;
      queueReminderSync();
      persist();
      renderCalendar();
      if(activeKey===hit.key) renderTaskList();
      setReminderDiag('Task marked done from notification');
    }
    return;
  }

  if(actionId==='snooze'){
    const snoozeAt=new Date(Date.now()+REMINDER_SNOOZE_MINUTES*60000);
    const snoozeKey=keyFromDate(snoozeAt);
    if(snoozeKey===hit.key){
      hit.task.time=hmFromDate(snoozeAt);
      hit.task.done=false;
      queueReminderSync();
      persist();
      renderCalendar();
      if(activeKey===hit.key) renderTaskList();
    } else if(canUseNativeReminders()){
      const LocalNotifications=getNativeReminderPlugin();
      await LocalNotifications.schedule({
        notifications:[{
          id:reminderIdForTask(hit.key,hit.task)+400000,
          title:'DayScore - Task Due',
          body:(hit.task.text||'Task due now').slice(0,120),
          channelId:REMINDER_CHANNEL_ID,
          actionTypeId:REMINDER_ACTION_TYPE_ID,
          extra:{taskKey:hit.key,taskId:String(hit.task.id)},
          schedule:{at:snoozeAt,allowWhileIdle:true}
        }]
      });
    }
    setReminderDiag(`Snoozed ${REMINDER_SNOOZE_MINUTES} minutes`);
  }
}
function parseDueDate(key,time){
  const m=/^(\d{1,2}):(\d{1,2})$/.exec((time||'').trim());
  if(!m) return null;
  const hh=Number(m[1]), mm=Number(m[2]);
  if(hh<0||hh>23||mm<0||mm>59) return null;
  const [y,mo,d]=key.split('-').map(Number);
  if(!y||!mo||!d) return null;
  const due=new Date(y,mo-1,d,hh,mm,0,0);
  return Number.isNaN(due.getTime())?null:due;
}
async function clearNativeReminderTracking(){
  const ids=JSON.parse(localStorage.getItem(REMINDER_TRACKED_IDS_KEY)||'[]');
  if(canUseNativeReminders()&&ids.length){
    try{
      await getNativeReminderPlugin().cancel({notifications:ids.map(id=>({id:Number(id)}))});
    }catch(e){
      console.warn('Cancel native reminders failed:',e);
    }
  }
  localStorage.removeItem(REMINDER_TRACKED_IDS_KEY);
  localStorage.removeItem(REMINDER_TRACKED_PAYLOADS_KEY);
}
async function syncNativeReminders(){
  if(!canUseNativeReminders()) return;
  const desired=[];
  const now=Date.now();
  Object.keys(state.tasks||{}).forEach(key=>{
    (state.tasks[key]||[]).forEach(task=>{
      if(!task.time||task.done) return;
      let due=parseDueDate(key,task.time);
      if(!due) return;
      const dueMs=due.getTime();
      if(dueMs<=now) return;
      desired.push({
        id:reminderIdForTask(key,task),
        title:'DayScore - Task Due',
        body:(task.text||'Task due now').slice(0,120),
        at:due.getTime(),
        taskKey:key,
        taskId:String(task.id)
      });
    });
  });

  const nativeBridge=getDayScoreReminderPlugin();
  if(nativeBridge&&typeof nativeBridge.sync==='function'){
    try{
      await nativeBridge.sync({notifications:desired});
      setSyncStatus('synced',`Scheduled ${desired.length} reminder${desired.length===1?'':'s'}`);
      return;
    }catch(e){
      console.warn('DayScore native reminder sync failed, falling back to LocalNotifications:',e);
    }
  }

  const ready=await ensureNativeReminderReady(false);
  if(!ready) return;
  const LocalNotifications=getNativeReminderPlugin();
  const trackedIds=JSON.parse(localStorage.getItem(REMINDER_TRACKED_IDS_KEY)||'[]').map(Number).filter(Number.isFinite);
  const trackedPayloads=JSON.parse(localStorage.getItem(REMINDER_TRACKED_PAYLOADS_KEY)||'{}');
  const desiredIds=desired.map(n=>n.id);
  const desiredPayloads={};
  desired.forEach(n=>{ desiredPayloads[String(n.id)]=`${n.body}|${n.at}`; });

  let pendingIds=new Set();
  if(typeof LocalNotifications.getPending==='function'){
    try{
      const pending=await LocalNotifications.getPending();
      pendingIds=new Set((pending?.notifications||[]).map(n=>Number(n?.id)).filter(Number.isFinite));
    }catch(_e){}
  }

  const cancelIds=trackedIds.filter(id=>!desiredIds.includes(id));
  const upsert=desired.filter(n=>{
    const id=Number(n.id);
    const changed=trackedPayloads[String(id)]!==desiredPayloads[String(id)];
    const missingFromOs=!pendingIds.has(id);
    const neverTracked=!trackedIds.includes(id);
    return changed||missingFromOs||neverTracked;
  });

  if(cancelIds.length){
    await LocalNotifications.cancel({notifications:cancelIds.map(id=>({id}))});
  }
  if(!desired.length){
    setSyncStatus('synced','No pending reminders');
    localStorage.setItem(REMINDER_TRACKED_IDS_KEY,JSON.stringify([]));
    localStorage.setItem(REMINDER_TRACKED_PAYLOADS_KEY,JSON.stringify({}));
    localStorage.removeItem(REMINDER_OVERDUE_MARKS_KEY);
    return;
  }

  if(upsert.length){
    await LocalNotifications.schedule({notifications:upsert.map(n=>({
      id:n.id,
      title:n.title,
      body:n.body,
      channelId:REMINDER_CHANNEL_ID,
      actionTypeId:REMINDER_ACTION_TYPE_ID,
      extra:{taskKey:n.taskKey,taskId:n.taskId},
      schedule:{at:new Date(n.at),allowWhileIdle:true}
    }))});
  }
  localStorage.setItem(REMINDER_TRACKED_IDS_KEY,JSON.stringify(desiredIds));
  localStorage.setItem(REMINDER_TRACKED_PAYLOADS_KEY,JSON.stringify(desiredPayloads));
  setSyncStatus('synced',`Scheduled ${desired.length} reminder${desired.length===1?'':'s'}`);
}
function queueReminderSync(immediate=false){
  clearTimeout(reminderSyncTimer);
  if(immediate){
    syncNativeReminders().catch(e=>console.warn('Native reminder sync failed:',e));
    refreshReminderDiagnostics();
    return;
  }
  reminderSyncTimer=setTimeout(()=>{ syncNativeReminders().catch(e=>console.warn('Native reminder sync failed:',e)); refreshReminderDiagnostics(); },100);
}
async function requestNotifPermission(){
  if(canUseNativeReminders()){
    await ensureNativeReminderReady(true);
    return;
  }
}
async function sendReminderTestNotification(){
  if(canUseNativeReminders()){
    const ready=await ensureNativeReminderReady(true);
    if(!ready) return;
    const LocalNotifications=getNativeReminderPlugin();
    const nowPlus2s=new Date(Date.now()+2000);
    const when=new Date(Date.now()+10000);
    try{
      await LocalNotifications.schedule({
        notifications:[
          {
            id:1999999998,
            title:'DayScore Test (Now)',
            body:'If banner/sound appears now, native notifications are working.',
            channelId:REMINDER_CHANNEL_ID,
            actionTypeId:REMINDER_ACTION_TYPE_ID,
            extra:{taskKey:'',taskId:'0'},
            schedule:{at:nowPlus2s,allowWhileIdle:true}
          },
          {
            id:1999999999,
            title:'DayScore Test (10s)',
            body:'Second reminder check after 10 seconds.',
            channelId:REMINDER_CHANNEL_ID,
            actionTypeId:REMINDER_ACTION_TYPE_ID,
            extra:{taskKey:'',taskId:'0'},
            schedule:{at:when,allowWhileIdle:true}
          }
        ]
      });
      let pendingCount='unknown';
      if(typeof LocalNotifications.getPending==='function'){
        try{
          const pending=await LocalNotifications.getPending();
          pendingCount=String((pending?.notifications||[]).length);
        }catch(_e){}
      }
      setReminderDiag('Test queued: one in ~2s and one in ~10s');
      alert(`Test alerts scheduled (~2s and ~10s). Pending in OS queue: ${pendingCount}. Lock screen and watch for banner/sound.`);
    }catch(e){
      console.warn('Test reminder failed:',e);
      setReminderDiag('Test failed: check notification + exact alarm settings');
      alert('Test reminder failed. Please allow notifications and exact alarms in Android settings.');
    }
    return;
  }
  alert('Native reminder plugin not available in this release build.');
}
async function sendTaskPathTestNotification(){
  if(!canUseNativeReminders()){
    alert('Native reminder plugin not available in this release build.');
    return;
  }
  const ready=await ensureNativeReminderReady(true);
  if(!ready) return;
  const LocalNotifications=getNativeReminderPlugin();
  const now=new Date();
  const nowKey=toKey(now.getFullYear(),now.getMonth(),now.getDate());
  const testTask={id:777777001,text:'Task-path test reminder',time:hmFromDate(new Date(Date.now()+20000))};
  const due=parseDueDate(nowKey,testTask.time);
  if(!due){
    alert('Could not create task-path test due time.');
    return;
  }
  const payload={
    id:reminderIdForTask(nowKey,testTask),
    title:'DayScore Task Reminder Test',
    body:'This uses the same path as normal task reminders.',
    channelId:REMINDER_CHANNEL_ID,
    actionTypeId:REMINDER_ACTION_TYPE_ID,
    extra:{taskKey:nowKey,taskId:String(testTask.id),kind:'task-path-test'},
    schedule:{at:due,allowWhileIdle:true}
  };
  try{
    await LocalNotifications.schedule({notifications:[payload]});
    let pendingCount='unknown';
    try{
      const pending=await LocalNotifications.getPending();
      pendingCount=String((pending?.notifications||[]).length);
    }catch(_e){}
    setReminderDiag(`Task-path test queued for ${formatReminderTime(due)}`);
    alert(`Task-path test scheduled for ~20s from now. Pending in OS queue: ${pendingCount}. This uses normal task reminder fields.`);
  }catch(e){
    console.warn('Task-path test failed:',e);
    setReminderDiag('Task-path test failed');
    alert('Task-path test failed. Check exact alarm and app battery restrictions.');
  }
}
async function openAppNotificationSettings(){
  try{
    const AppPlugin=window.Capacitor?.Plugins?.App;
    if(AppPlugin&&typeof AppPlugin.openSettings==='function'){
      await AppPlugin.openSettings();
      return;
    }
  }catch(_e){}
  alert('Could not open settings automatically. Open Android Settings > Apps > DayScore > Notifications/Battery.');
}

// ── SETTINGS ───────────────────────────────────────────────────
const TDESC={10:'just show up',25:'light effort counts',50:'complete half or more',75:'almost everything done',100:'every single task'};
function thresholdDesc(v){ const keys=Object.keys(TDESC).map(Number).sort((a,b)=>a-b); for(let i=keys.length-1;i>=0;i--) if(v>=keys[i]) return TDESC[keys[i]]; return ''; }
function updateSettingsUI(){
  const v=state.threshold;
  document.getElementById('thresholdVal').textContent=v+'%';
  document.getElementById('thresholdSlider').value=v;
  document.getElementById('thresholdDesc').textContent=thresholdDesc(v);
  document.querySelectorAll('.preset-btn').forEach(b=>b.classList.toggle('active',parseInt(b.textContent)===v));
}
window.setPreset=function(v){ state.threshold=v; persist(); updateSettingsUI(); renderCalendar(); };
document.getElementById('thresholdSlider').addEventListener('input',e=>{ state.threshold=parseInt(e.target.value); persist(); updateSettingsUI(); renderCalendar(); });

function openDiaryBookModal(){
  const overlay=document.getElementById('diaryModalOverlay');
  const dateInput=document.getElementById('diaryModalDateInput');
  if(dateInput) dateInput.value='';
  renderDiaryBookModal();
  if(overlay) overlay.classList.add('open');
}
function renderDiaryBookModal(filterKey=''){
  const wrapper=document.getElementById('diaryPagesWrapper');
  const indicator=document.getElementById('diaryModalIndicator');
  if(!wrapper||!indicator) return;
  let entries=collectDiaryEntries();
  if(filterKey) entries=entries.filter(e=>e.key===filterKey);
  const pages=buildDiaryBookPages(entries);
  if(!pages.length){
    wrapper.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:var(--muted2);">No diary entry found for this date.</div>';
    indicator.textContent='';
  } else {
    wrapper.innerHTML=pages.map(p=>{
      const e0=p[0], e1=p[1];
      const page0=!e0?'<div class="diary-page-modal"><div class="diary-page-content-modal diary-page-empty-modal">This day is unwritten...</div></div>':`<div class="diary-page-modal"><div class="diary-page-date-modal">${formatDiaryDate(e0.date)}</div><div class="diary-page-content-modal">${escHtml(e0.content)}</div></div>`;
      const page1=!e1?'<div class="diary-page-modal"><div class="diary-page-content-modal diary-page-empty-modal">This day is unwritten...</div></div>':`<div class="diary-page-modal"><div class="diary-page-date-modal">${formatDiaryDate(e1.date)}</div><div class="diary-page-content-modal">${escHtml(e1.content)}</div></div>`;
      return page0+page1;
    }).join('');
    indicator.textContent=filterKey?'1 result':`${pages.length} page${pages.length!==1?'s':''}`;
  }
}
function closeDiaryBookModal(){
  const overlay=document.getElementById('diaryModalOverlay');
  if(overlay) overlay.classList.remove('open');
}

// ── EVENTS ─────────────────────────────────────────────────────
document.getElementById('closeBtn').addEventListener('click',closeModal);
document.getElementById('diaryModalClose').addEventListener('click',closeDiaryBookModal);
document.getElementById('diaryModalOverlay').addEventListener('click',e=>{ if(e.target===document.getElementById('diaryModalOverlay'))closeDiaryBookModal(); });
document.getElementById('diaryModalSearchBtn').addEventListener('click',()=>{
  const input=document.getElementById('diaryModalDateInput');
  const raw=(input?.value||'').trim();
  if(!raw){
    renderDiaryBookModal();
    return;
  }
  const [y,m,d]=raw.split('-').map(Number);
  if(!y||!m||!d) return;
  renderDiaryBookModal(toKey(y,m-1,d));
});
document.getElementById('modalOverlay').addEventListener('click',e=>{ if(e.target===document.getElementById('modalOverlay'))closeModal(); });
document.getElementById('cfOverlay').addEventListener('click',e=>{ if(e.target===document.getElementById('cfOverlay'))closeCF(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){closeModal();closeCF();closeDiaryBookModal();} });
document.getElementById('prevBtn').addEventListener('click',()=>{ if(--viewMonth<0){viewMonth=11;viewYear--;} renderCalendar(); });
document.getElementById('nextBtn').addEventListener('click',()=>{ if(++viewMonth>11){viewMonth=0;viewYear++;} renderCalendar(); });
document.getElementById('settingsBtn').addEventListener('click',e=>{ e.stopPropagation(); document.getElementById('settingsPanel').classList.toggle('open'); });
document.getElementById('settingsBtn').addEventListener('click',()=>{ refreshReminderDiagnostics(); });
document.getElementById('reminderTestBtn').addEventListener('click',()=>{ sendReminderTestNotification().catch(()=>{}); });
document.getElementById('reminderTaskPathTestBtn').addEventListener('click',()=>{ sendTaskPathTestNotification().catch(()=>{}); });
document.getElementById('reminderReportBtn').addEventListener('click',()=>{ runReminderSurvey().catch(()=>{}); });
document.getElementById('reminderOpenSettingsBtn').addEventListener('click',()=>{ openAppNotificationSettings().catch(()=>{}); });
document.addEventListener('click',e=>{ const p=document.getElementById('settingsPanel'); if(!p.contains(e.target)&&!e.target.closest('#settingsBtn'))p.classList.remove('open'); });
document.getElementById('quickAddBtn').addEventListener('click',()=>{
  const t=today();
  openModal(toKey(t.y,t.m,t.d));
});

// Reload when app comes back to foreground
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&currentUser){
    const now = nowTs();
    if(now - lastForegroundRefreshAt < 5000) return;
    lastForegroundRefreshAt = now;
    loadFromFirebase().then(()=>{ renderCalendar(); queueReminderSync(); renderUtilityDrawer(); });
  } else if(document.visibilityState==='hidden'){
    queueReminderSync(true);
  }
});

if(window.Capacitor?.Plugins?.App?.addListener){
  window.Capacitor.Plugins.App.addListener('appStateChange',({isActive})=>{
    if(isActive){
      queueReminderSync();
      refreshReminderDiagnostics();
    } else {
      queueReminderSync(true);
    }
  });
}

window.addEventListener('pagehide',()=>{ queueReminderSync(true); });

// ── INIT ───────────────────────────────────────────────────────
initTheme();
const tStart=today(); viewYear=tStart.y; viewMonth=tStart.m;
startPomodoroTicker();
setupUtilityDrawer();
