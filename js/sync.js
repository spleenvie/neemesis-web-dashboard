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
  let lastError = '';
  let workspaceId = 'neemesis-main';
  let configured = false;
  let authLoading = false;

  function setStatus(next, detail) {
    status = next;
    if (detail) lastError = detail;
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
    el.title = lastError || labels[next] || '';
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
    const msg = e && e.message ? e.message : String(e);
    if (code === 'permission-denied') {
      return 'Firestore: accès refusé. Vérifiez que vous êtes connecté et que les règles sont publiées.';
    }
    if (code === 'unauthenticated') {
      return 'Session expirée — reconnectez-vous.';
    }
    if (code === 'failed-precondition' || code === 'not-found') {
      return 'Firestore: base non trouvée. Créez Firestore (mode production) dans la console Firebase.';
    }
    if (code === 'unavailable' || code === 'deadline-exceeded') {
      return 'Firestore indisponible — vérifiez votre connexion.';
    }
    if (/REFERER|API_KEY|API key/i.test(msg)) {
      return 'Clé API bloquée. Dans Google Cloud → Credentials, autorisez https://spleenvie.github.io/*';
    }
    return (code ? code + ' — ' : '') + msg;
  }

  function ensureState() {
    if (!window.S || !window.S.tasks) {
      window.S = typeof window.emptyData === 'function' ? window.emptyData() : loadLocal() || {};
    }
    return window.S;
  }

  function setState(data) {
    window.S = data;
  }

  function applyRemote(data, options) {
    if (!data || !data.tasks) return;
    setState(data);
    backupLocal(data);
    if (!options || !options.silent) {
      if (typeof window.onDataRemote === 'function') window.onDataRemote();
    }
  }

  function docRef() {
    return db.collection('workspaces').doc(workspaceId);
  }

  async function ensureAuthReady() {
    const user = auth && auth.currentUser;
    if (!user) throw new Error('Utilisateur non authentifié');
    await user.getIdToken(true);
  }

  async function seedIfEmpty() {
    const snap = await docRef().get();
    if (snap.exists) return;
    const payload = typeof window.emptyData === 'function' ? window.emptyData() : null;
    if (!payload) throw new Error('emptyData() indisponible — vérifiez que js/data.js est chargé');
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
        const detail = formatFirebaseError(err);
        setStatus('error', detail);
        toast(detail);
      }
    );
  }

  function renderApp() {
    try {
      if (typeof window.onDataReady === 'function') window.onDataReady();
    } catch (e) {
      console.error('Render error', e);
      toast('Erreur affichage: ' + e.message);
    }
  }

  async function afterAuth() {
    setStatus('connecting');
    showAuth(false);
    showApp(true);
    try {
      await ensureAuthReady();
      await seedIfEmpty();
      const snap = await docRef().get();
      if (snap.exists) {
        const payload = snap.data().data;
        if (payload && payload.tasks) applyRemote(payload, { silent: true });
        else ensureState();
      } else {
        ensureState();
      }
      startListener();
      setStatus('synced');
      renderApp();
    } catch (e) {
      console.error('NeemSync afterAuth error:', e);
      ensureState();
      const detail = formatFirebaseError(e);
      setStatus('error', detail);
      toast(detail);
      renderApp();
    }
  }

  function initFirebase() {
    if (!configured) {
      firebase.initializeApp(window.FIREBASE_CONFIG);
      db = firebase.firestore();
      auth = firebase.auth();
      auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
      configured = true;
    }
  }

  function bootLocalOnly() {
    setStatus(isConfigured() ? 'auth' : 'setup');
    window.S = loadLocal() || (typeof window.emptyData === 'function' ? window.emptyData() : {});
    showApp(true);
    renderApp();
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
        if (authLoading) return;
        authLoading = true;
        try {
          await afterAuth();
        } finally {
          authLoading = false;
        }
      } else {
        setStatus('auth');
        showAuth(true);
        showApp(false);
      }
    });
  }

  function persist(data) {
    setState(data);
    backupLocal(data);
    if (!db || !auth || !auth.currentUser) return;

    setStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await ensureAuthReady();
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
        const detail = formatFirebaseError(e);
        setStatus('error', detail);
        toast('Échec enregistrement: ' + detail);
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
    setState(empty);
    try { localStorage.removeItem(KEY); } catch (e) {}
    if (db && auth && auth.currentUser) {
      try {
        await ensureAuthReady();
        ignoreRemote = true;
        await docRef().set({
          data: empty,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        setStatus('synced');
      } catch (e) {
        const detail = formatFirebaseError(e);
        setStatus('error', detail);
        toast(detail);
      }
    }
    renderApp();
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
