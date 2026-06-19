const NeemSync = (() => {
  const KEY = 'neemesis_v1';
  const SAVE_DEBOUNCE_MS = 450;

  let db = null;
  let auth = null;
  let unsubscribe = null;
  let saveTimer = null;
  let ignoreRemote = false;
  let ignoreTimer = null;
  let status = 'offline';
  let workspaceId = 'neemesis-main';
  let configured = false;

  function setStatus(next) {
    status = next;
    const el = document.getElementById('sync-status');
    if (!el) return;
    el.dataset.status = next;
    const labelEl = el.querySelector('span:last-child');
    const labels = {
      offline: 'Hors ligne',
      setup: 'Config requise',
      connecting: 'Connexion…',
      auth: 'Connexion requise',
      synced: 'Synchronisé',
      saving: 'Enregistrement…',
      error: 'Erreur sync'
    };
    if (labelEl) labelEl.textContent = labels[next] || next;
  }

  function isConfigured() {
    const cfg = window.FIREBASE_CONFIG;
    return !!(cfg && cfg.apiKey && cfg.apiKey !== 'VOTRE_API_KEY' && cfg.projectId && cfg.projectId !== 'VOTRE_PROJECT_ID');
  }

  function showAuth(show) {
    const el = document.getElementById('auth-overlay');
    if (el) el.classList.toggle('open', show);
  }

  function showApp(show) {
    const sidebar = document.querySelector('.sidebar');
    const main = document.querySelector('.main');
    if (sidebar) sidebar.style.visibility = show ? 'visible' : 'hidden';
    if (main) main.style.visibility = show ? 'visible' : 'hidden';
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && data.tasks) return data;
      }
    } catch (e) {}
    return null;
  }

  function backupLocal(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {}
  }

  function formatFirebaseError(e) {
    const code = e && e.code ? e.code : '';
    if (code === 'permission-denied') {
      return 'Accès Firestore refusé — publiez firestore.rules dans la console Firebase.';
    }
    if (code === 'unauthenticated') {
      return 'Session expirée — reconnectez-vous.';
    }
    if (code === 'unavailable' || code === 'deadline-exceeded') {
      return 'Firestore indisponible — vérifiez votre connexion.';
    }
    return 'Impossible de charger les données cloud';
  }

  function ensureState() {
    if (!window.S || !window.S.tasks) {
      window.S = typeof window.emptyData === 'function' ? window.emptyData() : loadLocal() || {};
    }
    return window.S;
  }

  function applyRemote(data) {
    if (!data || !data.tasks) return;
    window.S = data;
    backupLocal(data);
    if (typeof window.onDataRemote === 'function') window.onDataRemote();
  }

  function docRef() {
    return db.collection('workspaces').doc(workspaceId);
  }

  async function seedIfEmpty() {
    const snap = await docRef().get();
    if (snap.exists) return;
    const payload = typeof window.emptyData === 'function' ? window.emptyData() : null;
    if (!payload) return;
    ignoreRemote = true;
    await docRef().set({
      data: payload,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  function startListener() {
    if (unsubscribe) unsubscribe();
    unsubscribe = docRef().onSnapshot(
      (snap) => {
        if (!snap.exists) return;
        if (ignoreRemote) {
          ignoreRemote = false;
          if (ignoreTimer) clearTimeout(ignoreTimer);
          setStatus('synced');
          return;
        }
        const remote = snap.data().data;
        if (!remote || !remote.tasks) return;
        applyRemote(remote);
        setStatus('synced');
      },
      (err) => {
        console.error('Firestore listener error', err);
        setStatus('error');
        toast(formatFirebaseError(err));
      }
    );
  }

  async function afterAuth() {
    setStatus('connecting');
    showAuth(false);
    showApp(true);
    try {
      await seedIfEmpty();
      const snap = await docRef().get();
      if (snap.exists) {
        const payload = snap.data().data;
        if (payload && payload.tasks) applyRemote(payload);
        else ensureState();
      } else {
        ensureState();
      }
      startListener();
      setStatus('synced');
      if (typeof window.onDataReady === 'function') window.onDataReady();
    } catch (e) {
      console.error('NeemSync afterAuth error:', e);
      ensureState();
      setStatus('error');
      toast(formatFirebaseError(e));
      if (typeof window.onDataReady === 'function') window.onDataReady();
    }
  }

  function initFirebase() {
    if (!configured) {
      firebase.initializeApp(window.FIREBASE_CONFIG);
      db = firebase.firestore();
      auth = firebase.auth();
      configured = true;
    }
  }

  function bootLocalOnly() {
    setStatus(isConfigured() ? 'auth' : 'setup');
    window.S = loadLocal() || (typeof window.emptyData === 'function' ? window.emptyData() : {});
    showApp(true);
    if (typeof window.onDataReady === 'function') window.onDataReady();
    if (isConfigured()) showAuth(true);
  }

  function boot() {
    workspaceId = window.NEEMESIS_WORKSPACE_ID || 'neemesis-main';
    showApp(false);

    if (!isConfigured()) {
      bootLocalOnly();
      return;
    }

    initFirebase();
    setStatus('connecting');

    auth.onAuthStateChanged(async (user) => {
      if (user) {
        await afterAuth();
      } else {
        setStatus('auth');
        showAuth(true);
        showApp(false);
      }
    });
  }

  function persist(data) {
    window.S = data;
    backupLocal(data);
    if (!db || !auth || !auth.currentUser) return;

    setStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        ignoreRemote = true;
        if (ignoreTimer) clearTimeout(ignoreTimer);
        ignoreTimer = setTimeout(() => {
          ignoreRemote = false;
        }, 2000);

        await docRef().set({
          data,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        setStatus('synced');
      } catch (e) {
        console.error(e);
        setStatus('error');
        toast('Échec de l\'enregistrement cloud');
      }
    }, SAVE_DEBOUNCE_MS);
  }

  async function login(email, password) {
    initFirebase();
    const errEl = document.getElementById('auth-error');
    if (errEl) errEl.textContent = '';
    try {
      await auth.signInWithEmailAndPassword(email, password);
    } catch (e) {
      if (errEl) errEl.textContent = 'Email ou mot de passe incorrect.';
      throw e;
    }
  }

  async function logout() {
    if (auth) await auth.signOut();
    showAuth(true);
    showApp(false);
    setStatus('auth');
  }

  async function resetWorkspace() {
    if (!confirm('Supprimer toutes les données et repartir à zéro ? Action irréversible pour toute l\'équipe.')) return;
    const empty = typeof window.emptyData === 'function' ? window.emptyData() : {};
    window.S = empty;
    try { localStorage.removeItem(KEY); } catch (e) {}
    if (db && auth && auth.currentUser) {
      ignoreRemote = true;
      await docRef().set({
        data: empty,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    setStatus(db && auth && auth.currentUser ? 'synced' : status);
    if (typeof window.onDataReady === 'function') window.onDataReady();
    toast('Tableau réinitialisé ✓');
  }

  return { boot, persist, login, logout, resetWorkspace, getStatus: () => status, isConfigured };
})();

function save() {
  NeemSync.persist(window.S);
}

function resetWorkspace() {
  NeemSync.resetWorkspace();
}

async function submitAuth(event) {
  event.preventDefault();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const btn = document.getElementById('auth-submit');
  if (btn) btn.disabled = true;
  try {
    await NeemSync.login(email, password);
  } catch (e) {
    /* error shown in form */
  } finally {
    if (btn) btn.disabled = false;
  }
}
