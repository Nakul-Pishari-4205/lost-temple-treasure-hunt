const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js';
const STORAGE_KEY = 'lost-temple-save-v1';
const FIREBASE_VERSION = '11.0.2';
const $ = (id) => document.getElementById(id);

const ui = {
  canvas: $('game-canvas'),
  hud: $('hud'),
  menu: $('menu-screen'),
  howto: $('howto-screen'),
  settings: $('settings-screen'),
  pause: $('pause-screen'),
  result: $('result-screen'),
  mobile: $('mobile-controls'),
  loading: $('loading-screen'),
  health: $('health-fill'),
  healthValue: $('health-value'),
  relics: $('relic-count'),
  score: $('score-value'),
  objective: $('objective-text'),
  prompt: $('interaction-prompt'),
  toast: $('toast'),
};

const saved = readSave();
let accountSave = null;
let accountUser = null;
let firebaseServices = null;
let accountReady = false;
let accountRevision = 0;
let cloudSaveQueue = Promise.resolve();
const settings = {
  sound: saved.sound !== false,
  reducedMotion: saved.reducedMotion === true,
};
let THREE = null;
let renderer = null;
let scene = null;
let camera = null;
let worldRoot = null;
let lastFrame = 0;
let toastTimer = 0;
let audioContext = null;
let masterGain = null;
let ambience = null;
let runSeed = 1;
let random = Math.random;
let state = 'menu';
let score = 0;
let health = 100;
let relics = 0;
let chestsOpened = 0;
let invulnerable = 0;
let elapsed = 0;
let traps = [];
let solidRects = [];
let torches = [];
let particles = [];
let pickups = [];
let chests = [];
let exitGate = null;
let player = null;
let playerParts = null;
let jumpVelocity = 0;
let grounded = true;
let keys = Object.create(null);
let stick = { active: false, x: 0, y: 0, pointerId: null };
let joystickOrigin = null;
let mobileButtons = { interact: false, jump: false, sprint: false };

function readSave() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return normalizeSave(data);
  } catch (error) {
    console.warn('Could not read expedition settings from local storage.', error);
    return normalizeSave({});
  }
}

function normalizeSave(data) {
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const safeCount = (count) => {
    const number = Number(count);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  };
  return {
    sound: value.sound !== false,
    reducedMotion: value.reducedMotion === true,
    bestScore: safeCount(value.bestScore),
    expeditions: safeCount(value.expeditions),
    relicsFound: safeCount(value.relicsFound),
  };
}

function activeSave() {
  return accountUser ? accountSave : saved;
}

function updateAccountSummary() {
  const profile = activeSave() || saved;
  const best = profile.bestScore;
  $('best-score').textContent = best > 0 ? `PERSONAL BEST  ·  ${String(best).padStart(6, '0')}` : '';
  if (accountUser) {
    $('account-summary').textContent = 'Cloud sync enabled · saved to your account';
    $('account-email').textContent = accountUser.email || accountUser.displayName || 'Signed-in adventurer';
    $('account-avatar').textContent = (accountUser.displayName || accountUser.email || 'A').trim().charAt(0).toUpperCase();
    $('account-stats').textContent = `${profile.expeditions} EXPEDITIONS  ·  ${profile.relicsFound} RELICS RECOVERED`;
  } else {
    $('account-summary').textContent = 'Playing as a guest · this device only';
  }
}

function applySave(profile) {
  const normalized = normalizeSave(profile);
  if (accountUser) accountSave = normalized;
  else Object.assign(saved, normalized);
  settings.sound = normalized.sound;
  settings.reducedMotion = normalized.reducedMotion;
  $('sound-toggle').checked = settings.sound;
  $('reduced-motion').checked = settings.reducedMotion;
  updateAccountSummary();
}

function writeSave({ completedExpedition = false, recoveredRelics = 0 } = {}) {
  try {
    const profile = activeSave();
    if (accountUser && !accountReady) {
      setAccountStatus('Your account save is still loading. This change has not been saved yet.');
      return;
    }
    profile.bestScore = Math.max(profile.bestScore, score);
    const saveData = {
      sound: settings.sound,
      reducedMotion: settings.reducedMotion,
      bestScore: profile.bestScore,
      expeditions: profile.expeditions,
      relicsFound: profile.relicsFound,
      updatedAt: new Date().toISOString(),
    };
    if (accountUser) {
      const { firestore, doc, runTransaction } = firebaseServices;
      const userId = accountUser.uid;
      cloudSaveQueue = cloudSaveQueue
        .catch((error) => console.error('A previous cloud save failed.', error))
        .then(() => runTransaction(firestore, async (transaction) => {
          const profileRef = doc(firestore, 'users', userId, 'gameData', 'profile');
          const snapshot = await transaction.get(profileRef);
          const remote = normalizeSave(snapshot.exists() ? snapshot.data() : {});
          const synchronized = {
            ...saveData,
            bestScore: Math.max(remote.bestScore, saveData.bestScore),
            expeditions: completedExpedition ? remote.expeditions + 1 : Math.max(remote.expeditions, saveData.expeditions),
            relicsFound: completedExpedition ? remote.relicsFound + recoveredRelics : Math.max(remote.relicsFound, saveData.relicsFound),
          };
          transaction.set(profileRef, synchronized, { merge: true });
          return synchronized;
        }))
        .then((synchronized) => {
          if (accountUser?.uid === userId) {
            accountSave = normalizeSave(synchronized);
            updateAccountSummary();
            setAccountStatus('Your expedition is synced to your account.');
          }
        })
        .catch((error) => {
          console.error('Could not sync your expedition to the account.', error);
          if (accountUser?.uid === userId) setAccountStatus('Cloud save failed. Check your connection and Firebase setup, then try again.');
        });
    } else {
      Object.assign(saved, saveData);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      setAccountStatus('Guest saves stay on this device. Sign in to sync your expedition across devices.');
    }
    updateAccountSummary();
  } catch (error) {
    console.error('Could not save expedition profile.', error);
    setAccountStatus(accountUser
      ? 'Could not save your expedition to the account. Check your Firebase setup.'
      : 'Could not save guest progress on this device. Check browser storage settings.');
  }
}

async function boot() {
  $('sound-toggle').checked = settings.sound;
  $('reduced-motion').checked = settings.reducedMotion;
  updateAccountSummary();
  document.querySelectorAll('[data-provider]').forEach((button) => {
    button.addEventListener('click', () => signIn(button.dataset.provider));
  });
  $('signout-button').addEventListener('click', signOut);
  $('start-button').addEventListener('click', () => startGame(true));
  $('howto-button').addEventListener('click', () => showScreen('howto'));
  $('settings-button').addEventListener('click', () => showScreen('settings'));
  $('howto-back').addEventListener('click', () => showScreen('menu'));
  $('settings-back').addEventListener('click', () => showScreen('menu'));
  $('resume-button').addEventListener('click', resumeGame);
  $('restart-button').addEventListener('click', () => startGame(true));
  $('replay-button').addEventListener('click', () => startGame(true));
  $('menu-button').addEventListener('click', () => showScreen('menu'));
  $('pause-button').addEventListener('click', pauseGame);
  $('home-button').addEventListener('click', returnHome);
  $('pause-home-button').addEventListener('click', returnHome);
  $('sound-toggle').addEventListener('change', (event) => {
    settings.sound = event.target.checked;
    if (!settings.sound) stopAmbience();
    else if (state === 'playing') startAmbience();
    writeSave();
  });
  $('reduced-motion').addEventListener('change', (event) => {
    settings.reducedMotion = event.target.checked;
    writeSave();
  });

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    keys = Object.create(null);
    stick.active = false;
    stick.x = 0;
    stick.y = 0;
    mobileButtons = { interact: false, jump: false, sprint: false };
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === 'playing') pauseGame();
  });
  window.addEventListener('resize', resize);
  setupTouchControls();
  void initializeAccounts();

  let rendererTimeout;
  try {
    THREE = await Promise.race([
      import(THREE_URL),
      new Promise((_, reject) => {
        rendererTimeout = window.setTimeout(() => reject(new Error('Timed out loading the 3D renderer.')), 5000);
      }),
    ]);
    if (!THREE.WebGLRenderer) throw new Error('Three.js WebGL renderer is unavailable.');
    setupThree();
  } catch (error) {
    console.error('Unable to initialize the 3D temple renderer.', error);
    ui.loading.innerHTML = '<div class="renderer-error"><div class="renderer-error-mark" aria-hidden="true"></div><h2>3D GRAPHICS UNAVAILABLE</h2><p>This expedition requires WebGL and a connection to load the 3D renderer.</p><button id="reload-button" class="primary-button">TRY AGAIN</button></div>';
    $('reload-button').addEventListener('click', () => window.location.reload());
    return;
  } finally {
    window.clearTimeout(rendererTimeout);
  }

  makeWorld();
  resize();
  requestAnimationFrame(frame);
  window.setTimeout(() => ui.loading.classList.add('done'), 350);
  window.setTimeout(() => ui.loading.classList.add('is-hidden'), 900);
}

function setAccountStatus(message, isError = false) {
  const status = $('account-status');
  status.textContent = message;
  status.classList.toggle('account-status-error', isError);
}

function updateAccountControls(user) {
  $('account-providers').classList.toggle('is-hidden', Boolean(user));
  $('account-profile').classList.toggle('is-hidden', !user);
  $('account-profile').setAttribute('aria-hidden', String(!user));
  $('account-providers').setAttribute('aria-hidden', String(Boolean(user)));
}

function accountErrorMessage(error) {
  switch (error?.code) {
    case 'auth/popup-closed-by-user':
      return 'Sign-in was cancelled.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in window. Allow pop-ups and try again.';
    case 'auth/unauthorized-domain':
      return 'This website is not registered as an authorized domain in Firebase.';
    case 'auth/operation-not-allowed':
      return 'This sign-in provider is not enabled in the Firebase console.';
    case 'auth/account-exists-with-different-credential':
      return 'An account already exists with this email. Sign in using its original provider.';
    default:
      return 'Sign-in failed. Check your provider settings and internet connection, then try again.';
  }
}

async function initializeAccounts() {
  try {
    const { firebaseConfig } = await import('./firebase-config.js');
    if (!firebaseConfig.apiKey || !firebaseConfig.authDomain || !firebaseConfig.projectId || !firebaseConfig.appId) {
      setAccountStatus('Guest saves stay on this device. Add Firebase configuration to enable Google, Microsoft, and Apple account sync.');
      return;
    }
    const sdkUrl = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const [appSdk, authSdk, firestoreSdk] = await Promise.all([
      import(`${sdkUrl}/firebase-app.js`),
      import(`${sdkUrl}/firebase-auth.js`),
      import(`${sdkUrl}/firebase-firestore.js`),
    ]);
    const app = appSdk.initializeApp(firebaseConfig);
    const auth = authSdk.getAuth(app);
    const firestore = firestoreSdk.getFirestore(app);
    firebaseServices = { auth, firestore, ...authSdk, ...firestoreSdk };
    await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
    authSdk.onAuthStateChanged(auth, (user) => {
      void handleAccountChange(user);
    }, (error) => {
      console.error('Firebase authentication state could not be read.', error);
      setAccountStatus('Could not read your sign-in state. Refresh the page and try again.', true);
    });
    $('account-setup-link').classList.add('is-hidden');
    authSdk.getRedirectResult(auth).catch((error) => {
      console.error('The account sign-in redirect failed.', error);
      setAccountStatus(accountErrorMessage(error), true);
    });
  } catch (error) {
    console.error('Could not initialize account sign-in.', error);
    setAccountStatus('Cloud sign-in could not initialize. Check the Firebase configuration and try again.', true);
  }
}

async function handleAccountChange(user) {
  const revision = ++accountRevision;
  accountUser = user;
  accountSave = user ? normalizeSave({}) : null;
  accountReady = !user;
  updateAccountControls(user);
  if (!user) {
    applySave(saved);
    setAccountStatus('Playing as a guest. Guest saves stay on this device.');
    return;
  }

  updateAccountSummary();
  $('account-summary').textContent = 'Loading your private expedition save…';
  $('account-email').textContent = user.email || user.displayName || 'Signed-in adventurer';
  $('account-stats').textContent = '';
  setAccountStatus('Loading your account save…');
  try {
    const { firestore, doc, getDoc } = firebaseServices;
    const snapshot = await getDoc(doc(firestore, 'users', user.uid, 'gameData', 'profile'));
    if (revision !== accountRevision || accountUser?.uid !== user.uid) return;
    applySave(snapshot.exists() ? snapshot.data() : {});
    accountReady = true;
    setAccountStatus(snapshot.exists()
      ? 'Your private expedition save is synced to this account.'
      : 'Account ready. Your expedition data will now be saved to this account.');
  } catch (error) {
    console.error('Could not load the signed-in expedition save.', error);
    if (revision === accountRevision && accountUser?.uid === user.uid) {
      accountReady = false;
      setAccountStatus('Could not load this account save. Check your connection and Firestore rules; guest data remains separate.', true);
    }
  }
}

async function signIn(providerName) {
  if (!firebaseServices) {
    setAccountStatus('Account sign-in needs Firebase project configuration. Follow FIREBASE_SETUP.md, then reload the game.', true);
    return;
  }
  let provider;
  if (providerName === 'google') {
    provider = new firebaseServices.GoogleAuthProvider();
  } else if (providerName === 'microsoft') {
    provider = new firebaseServices.OAuthProvider('microsoft.com');
    provider.setCustomParameters({ prompt: 'select_account' });
  } else if (providerName === 'apple') {
    provider = new firebaseServices.OAuthProvider('apple.com');
    provider.addScope('email');
    provider.addScope('name');
  } else {
    setAccountStatus('That sign-in provider is not supported.', true);
    return;
  }

  setAccountStatus(`Connecting to ${providerName === 'microsoft' ? 'Microsoft' : providerName}…`);
  try {
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (mobile) await firebaseServices.signInWithRedirect(firebaseServices.auth, provider);
    else await firebaseServices.signInWithPopup(firebaseServices.auth, provider);
  } catch (error) {
    console.error(`Could not sign in with ${providerName}.`, error);
    setAccountStatus(accountErrorMessage(error), true);
  }
}

async function signOut() {
  if (!firebaseServices || !accountUser) return;
  try {
    await firebaseServices.signOut(firebaseServices.auth);
    setAccountStatus('Signed out. Guest saves on this device have not been changed.');
  } catch (error) {
    console.error('Could not sign out of the expedition account.', error);
    setAccountStatus('Sign-out failed. Check your connection and try again.', true);
  }
}

function setupThree() {
  try {
    renderer = new THREE.WebGLRenderer({
      canvas: ui.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x747868);
    scene.fog = new THREE.FogExp2(0x747868, .014);
    camera = new THREE.PerspectiveCamera(56, 1, .1, 130);

    scene.add(new THREE.HemisphereLight(0xdce0bc, 0x494033, 1.25));
    const sun = new THREE.DirectionalLight(0xffd49a, 2.5);
    sun.position.set(-20, 33, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1536, 1536);
    sun.shadow.camera.left = -43;
    sun.shadow.camera.right = 43;
    sun.shadow.camera.top = 43;
    sun.shadow.camera.bottom = -43;
    sun.shadow.normalBias = .035;
    scene.add(sun);
    scene.add(sun.target);

    worldRoot = new THREE.Group();
    scene.add(worldRoot);
  } catch (error) {
    if (renderer) renderer.dispose();
    renderer = null;
    throw error;
  }
}

function makeWorld() {
  runSeed = Math.floor(Math.random() * 1000000) + 1;
  random = seededRandom(runSeed);
  score = 0;
  health = 100;
  relics = 0;
  chestsOpened = 0;
  invulnerable = 0;
  elapsed = 0;
  traps = [];
  solidRects = [];
  torches = [];
  particles = [];
  pickups = [];
  chests = [];
  exitGate = null;
  player = { x: 0, z: 29, y: 0, yaw: 0, speed: 0 };
  jumpVelocity = 0;
  grounded = true;
  if (worldRoot) {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    while (worldRoot.children.length) {
      const child = worldRoot.children.pop();
      child.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const objectMaterial of objectMaterials) {
          if (!objectMaterial) continue;
          materials.add(objectMaterial);
          for (const value of Object.values(objectMaterial)) {
            if (value?.isTexture) textures.add(value);
          }
        }
      });
    }
    geometries.forEach((geometry) => geometry.dispose());
    textures.forEach((texture) => texture.dispose());
    materials.forEach((objectMaterial) => objectMaterial.dispose());
  }
  buildFloor();
  buildRuins();
  buildGate();
  buildTorches();
  buildTrapsAndLoot();
  buildExplorer();
  updateHud();
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function material(color, roughness = .9, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, ...extra });
}

function addMesh(geometry, mat, x, y, z, scale = null, cast = true, receive = true) {
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.position.set(x, y, z);
  if (scale) mesh.scale.set(scale[0], scale[1], scale[2]);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  worldRoot.add(mesh);
  return mesh;
}

function box(x, y, z, sx, sy, sz, mat, solid = false) {
  const mesh = addMesh(new THREE.BoxGeometry(sx, sy, sz), mat, x, y, z);
  if (solid) solidRects.push({ x, z, hx: sx / 2 + .38, hz: sz / 2 + .38 });
  return mesh;
}

function buildFloor() {
  const floorMaterial = material(0x777361, .98);
  if (THREE) {
    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = textureCanvas.height = 256;
    const ctx = textureCanvas.getContext('2d');
    ctx.fillStyle = '#777361';
    ctx.fillRect(0, 0, 256, 256);
    const stoneSize = 48;
    for (let row = 0; row < 6; row++) {
      for (let column = 0; column < 6; column++) {
        const x = column * stoneSize + (row % 2 ? stoneSize / 2 : 0) - stoneSize / 2;
        const y = row * stoneSize - stoneSize / 2;
        const shade = Math.floor(random() * 17) - 8;
        ctx.fillStyle = `rgb(${119 + shade},${115 + shade},${97 + shade})`;
        ctx.beginPath();
        ctx.moveTo(x + 5 + random() * 5, y + 3 + random() * 4);
        ctx.lineTo(x + stoneSize * .47 + random() * 5, y + random() * 5);
        ctx.lineTo(x + stoneSize - 4 - random() * 5, y + 4 + random() * 5);
        ctx.lineTo(x + stoneSize - random() * 5, y + stoneSize * .55 + random() * 5);
        ctx.lineTo(x + stoneSize * .62 + random() * 5, y + stoneSize - random() * 5);
        ctx.lineTo(x + 4 + random() * 5, y + stoneSize - 4 - random() * 5);
        ctx.lineTo(x + random() * 5, y + stoneSize * .43 + random() * 5);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(34,31,23,.4)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(18, 18);
    texture.colorSpace = THREE.SRGBColorSpace;
    floorMaterial.map = texture;
    floorMaterial.color.set(0xc2b99a);
    const ground = addMesh(new THREE.PlaneGeometry(84, 84), floorMaterial, 0, -.13, 0, null, false, true);
    ground.rotation.x = -Math.PI / 2;
  }
}

function buildRuins() {
  const stone = material(0xaaa084);
  const stoneLight = material(0xc0b28e);
  const darkStone = material(0x615e4f);
  const moss = material(0x515844);

  for (let i = 0; i < 56; i++) {
    const x = (random() - .5) * 72;
    const z = (random() - .5) * 68;
    if (Math.abs(x) < 11 && Math.abs(z) < 21) continue;
    const width = .35 + random() * 1.1;
    const height = .18 + random() * .48;
    const block = box(x, height / 2 - .03, z, width, height, .3 + random() * .8, random() > .55 ? stone : darkStone);
    block.rotation.y = random() * Math.PI;
  }

  for (const z of [-18, -11, -3, 5, 13, 21]) {
    makePillar(-12, z, stoneLight, true, random() * .2);
    makePillar(12, z, stoneLight, true, random() * .2);
  }
  for (const x of [-20, -15, 15, 20]) {
    makePillar(x, -27 + random() * 3, stone, true, random() * .15);
    makePillar(x, 27 + random() * 3, stone, true, random() * .15);
  }

  // Broken boundary walls frame the playable area without sealing exploration routes.
  for (const x of [-34, 34]) {
    for (const z of [-26, -8, 12, 29]) {
      const len = 7 + random() * 4;
      box(x, 1.1, z, 1.2, 2.2, len, stone, true);
      box(x, 2.28, z, 1.5, .24, len + .2, stoneLight);
    }
  }
  for (const z of [-34, 34]) {
    for (const x of [-27, -9, 9, 27]) {
      const len = 7 + random() * 4;
      box(x, 1.05, z, len, 2.1, 1.2, stone, true);
    }
  }

  // Scattered columns make a navigable, irregular ruin field.
  const columns = [
    [-7, -17], [7, -17], [-7, -7], [7, -7], [-7, 4], [7, 4],
    [-7, 15], [7, 15], [-18, 0], [18, 0], [-24, -15], [24, 15],
  ];
  for (const [x, z] of columns) makePillar(x, z, random() > .5 ? stone : moss, true, random() * .4);

  // Ancient paving stones and low broken stumps add readable depth.
  for (let i = 0; i < 27; i++) {
    const x = (random() - .5) * 57;
    const z = (random() - .5) * 57;
    if (Math.abs(x) < 8 && Math.abs(z) < 8) continue;
    const h = .35 + random() * 1.6;
    const stump = box(x, h / 2, z, .8 + random() * 1.6, h, .8 + random() * 1.6, random() > .6 ? moss : darkStone, true);
    stump.rotation.y = random() * .5;
  }
}

function makePillar(x, z, mat, solid = true, lean = 0) {
  const base = addMesh(new THREE.CylinderGeometry(1.02, 1.12, .35, 6), material(0x8e866f), x, .18, z);
  const shaft = addMesh(new THREE.CylinderGeometry(.72, .9, 4.8, 6), mat, x, 2.7, z);
  const cap = addMesh(new THREE.CylinderGeometry(1.05, .8, .42, 6), material(0xb5a789), x, 5.31, z);
  shaft.rotation.z = lean;
  cap.rotation.z = lean;
  base.rotation.y = shaft.rotation.y = cap.rotation.y = Math.PI / 6;
  if (solid) solidRects.push({ x, z, hx: 1.08, hz: 1.08 });
  return { base, shaft, cap };
}

function buildGate() {
  const stone = material(0x968d74);
  const gold = material(0xc29a57, .48, { emissive: 0x3e2708, emissiveIntensity: .5 });
  box(-3.1, 3.2, -32, 1.4, 6.4, 1.7, stone, true);
  box(3.1, 3.2, -32, 1.4, 6.4, 1.7, stone, true);
  box(0, 6.25, -32, 7.5, 1.5, 1.9, stone, true);
  box(0, 5.15, -32.18, 4.2, .28, .2, gold);
  box(0, 4.55, -32.18, 3.25, .16, .2, gold);
  const barrier = box(0, 2.55, -32, 4.55, 4.7, .28, material(0x485144, .4, { transparent: true, opacity: .78, emissive: 0x152017 }), false);
  exitGate = { mesh: barrier, x: 0, z: -32, open: false };
  solidRects.push({ x: 0, z: -32, hx: 2.65, hz: .33 });
  addMesh(new THREE.OctahedronGeometry(.45, 0), material(0xe5bd6f, .34, { emissive: 0x71531f, emissiveIntensity: .8 }), 0, 4.6, -32.3);
}

function buildTorches() {
  const spots = [[-10, -25], [10, -25], [-30, -9], [30, -9], [-10, 9], [10, 9], [-28, 26], [28, 26]];
  for (const [x, z] of spots) {
    const wood = material(0x55402a);
    const stick = addMesh(new THREE.CylinderGeometry(.12, .17, 2.1, 5), wood, x, 1.22, z);
    stick.rotation.z = (random() - .5) * .1;
    const flameMaterial = new THREE.MeshBasicMaterial({ color: 0xffa63c });
    const flame = addMesh(new THREE.OctahedronGeometry(.25, 0), flameMaterial, x, 2.45, z);
    const core = addMesh(new THREE.OctahedronGeometry(.12, 0), new THREE.MeshBasicMaterial({ color: 0xffe1a0 }), x, 2.48, z);
    const light = new THREE.PointLight(0xff9d42, 23, 12, 2);
    light.position.set(x, 2.6, z);
    worldRoot.add(light);
    torches.push({ flame, core, light, baseY: 2.45, phase: random() * 6 });
  }
}

function buildTrapsAndLoot() {
  const trapPoints = [
    [-4, 19], [4, 12], [-2, 4], [3, -4], [-3, -13], [5, -22],
  ];
  for (let i = 0; i < trapPoints.length; i++) makeTrap(trapPoints[i][0], trapPoints[i][1], i);

  const relicPoints = [[-19, 19], [19, -4], [-18, -22]];
  relicPoints.forEach(([x, z], index) => makePickup('relic', x + (random() - .5) * 1.2, z + (random() - .5) * 1.2, index));
  const gemPoints = [
    [-25, 19], [24, 24], [0, 23], [-25, 4], [24, -18], [0, -19],
    [-15, -8], [15, 10], [-1, -28], [28, 4], [-29, -26], [7, 28],
  ];
  gemPoints.forEach(([x, z], index) => makePickup('gem', x + (random() - .5) * 1.7, z + (random() - .5) * 1.7, index));
  const chestPoints = [[-27, -4], [27, 10], [0, -25], [0, 10]];
  chestPoints.forEach(([x, z], index) => makeChest(x + (random() - .5) * .8, z + (random() - .5) * .8, index));

  // A few replay-seeded crystal clusters reward exploring the side paths.
  for (let i = 0; i < 8; i++) {
    const side = random() > .5 ? 1 : -1;
    makePickup('shard', side * (22 + random() * 8), -20 + random() * 42, 50 + i);
  }
}

function makeTrap(x, z, index) {
  const plateMat = material(0x68644f);
  const plate = addMesh(new THREE.BoxGeometry(2.5, .08, 2.5), plateMat, x, -.035, z);
  const spikes = [];
  for (let i = 0; i < 9; i++) {
    const sx = x + (i % 3 - 1) * .62;
    const sz = z + (Math.floor(i / 3) - 1) * .62;
    const spike = addMesh(new THREE.ConeGeometry(.2, .72, 4), material(0x9b947f, .55, { metalness: .22 }), sx, -.45, sz);
    spike.rotation.y = Math.PI / 4;
    spikes.push(spike);
  }
  traps.push({ x, z, plate, spikes, phase: index * .71, active: false, cooldown: 0, pulse: random() * Math.PI * 2 });
}

function makePickup(kind, x, z, index) {
  const relic = kind === 'relic';
  const shard = kind === 'shard';
  const color = relic ? 0x62d5c0 : shard ? 0x77e5db : 0xe7b65c;
  const meshMaterial = material(color, .27, { metalness: relic ? .42 : .18, emissive: color, emissiveIntensity: relic ? .48 : .29 });
  const mesh = addMesh(relic ? new THREE.OctahedronGeometry(.72, 0) : new THREE.OctahedronGeometry(shard ? .32 : .37, 0), meshMaterial, x, relic ? .95 : .68, z);
  if (relic) {
    const ring = addMesh(new THREE.TorusGeometry(1.08, .045, 6, 24), material(0xe0c37b, .4, { emissive: 0x5a3d10, emissiveIntensity: .34 }), x, .94, z);
    ring.rotation.x = Math.PI / 2;
  }
  pickups.push({ kind, x, z, mesh, phase: index * .53, collected: false });
}

function makeChest(x, z, index) {
  const group = new THREE.Group();
  const wood = material(0x73502e);
  const trim = material(0xd2a85c, .43, { metalness: .35, emissive: 0x3a2108, emissiveIntensity: .22 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.55, .72, 1.12), wood);
  base.position.y = .47;
  base.castShadow = base.receiveShadow = true;
  group.add(base);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.55, .35, 1.12), wood);
  lid.position.set(0, .98, 0);
  lid.castShadow = lid.receiveShadow = true;
  group.add(lid);
  for (const xOff of [-.38, .38]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(.11, .82, 1.16), trim);
    strap.position.set(xOff, .69, 0);
    group.add(strap);
  }
  const lock = new THREE.Mesh(new THREE.BoxGeometry(.22, .27, .08), trim);
  lock.position.set(0, .72, -.59);
  group.add(lock);
  group.position.set(x, 0, z);
  worldRoot.add(group);
  solidRects.push({ x, z, hx: 1.1, hz: .9 });
  chests.push({ x, z, group, lid, opened: false, phase: index * .8 });
}

function buildExplorer() {
  const group = new THREE.Group();
  const robe = material(0x47584a);
  const leather = material(0x7b5531);
  const skin = material(0xc79267);
  const dark = material(0x302a22);
  const pack = material(0x9b7140);
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(.43, .65, 1.45, 6), robe);
  torso.position.y = 1.37;
  torso.castShadow = true;
  group.add(torso);
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(.54, .54, .16, 6), leather);
  belt.position.y = 1.04;
  group.add(belt);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.34, 8, 6), skin);
  head.position.y = 2.32;
  head.castShadow = true;
  group.add(head);
  const hat = new THREE.Mesh(new THREE.CylinderGeometry(.43, .35, .18, 7), dark);
  hat.position.y = 2.62;
  group.add(hat);
  const packMesh = new THREE.Mesh(new THREE.BoxGeometry(.62, .77, .3), pack);
  packMesh.position.set(0, 1.42, .48);
  packMesh.castShadow = true;
  group.add(packMesh);
  const limbs = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(.13, .16, .78, 5), robe);
    arm.position.set(side * .52, 1.46, 0);
    arm.rotation.z = side * -.22;
    arm.castShadow = true;
    group.add(arm);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(.18, .21, .7, 5), leather);
    leg.position.set(side * .23, .35, 0);
    leg.castShadow = true;
    group.add(leg);
    limbs.push({ arm, leg, side });
  }
  group.traverse((object) => {
    if (object.isMesh && object.material.color) object.userData.baseColor = object.material.color.getHex();
  });
  worldRoot.add(group);
  playerParts = { group, limbs };
  syncPlayerMesh();
}

function syncPlayerMesh() {
  if (!playerParts) return;
  playerParts.group.position.set(player.x, player.y, player.z);
  playerParts.group.rotation.y = player.yaw;
}

function addParticle(x, y, z, color = 0xffc06d) {
  if (!renderer) return;
  const particle = addMesh(new THREE.SphereGeometry(.055 + random() * .045, 5, 4), new THREE.MeshBasicMaterial({ color, transparent: true }), x, y, z, null, false, false);
  particles.push({ mesh: particle, vx: (random() - .5) * .52, vy: .25 + random() * .78, vz: (random() - .5) * .52, life: .8 + random() * 1.3, maxLife: 2.1 });
}

function startGame(newRun = false) {
  if (accountUser && !accountReady) {
    setAccountStatus('Wait for your account save to finish loading, or sign out to play as a guest.', true);
    return;
  }
  if (newRun || state === 'menu' || state === 'victory' || state === 'defeat') makeWorld();
  state = 'playing';
  showScreen(null);
  ui.hud.classList.remove('is-hidden');
  ui.mobile.classList.remove('is-hidden');
  updateHud();
  startAmbience();
  audioPing(180, .045, 'sine', .045);
}

function showScreen(name) {
  for (const [key, element] of Object.entries({ menu: ui.menu, howto: ui.howto, settings: ui.settings, pause: ui.pause, result: ui.result })) {
    element.classList.toggle('is-hidden', key !== name);
  }
  if (name === 'menu') {
    state = 'menu';
    ui.hud.classList.add('is-hidden');
    ui.mobile.classList.add('is-hidden');
    stopAmbience();
  }
}

function pauseGame() {
  if (state !== 'playing') return;
  state = 'paused';
  showScreen('pause');
  stopAmbience();
}

function resumeGame() {
  if (state !== 'paused') return;
  state = 'playing';
  showScreen(null);
  startAmbience();
}

function returnHome() {
  if (state === 'menu') return;
  keys = Object.create(null);
  stick.active = false;
  stick.x = 0;
  stick.y = 0;
  mobileButtons = { interact: false, jump: false, sprint: false };
  ui.prompt.classList.remove('visible');
  ui.toast.classList.remove('show');
  showScreen('menu');
}

function finishGame(won) {
  if (state !== 'playing') return;
  state = won ? 'victory' : 'defeat';
  stopAmbience();
  ui.hud.classList.add('is-hidden');
  ui.mobile.classList.add('is-hidden');
  ui.result.classList.remove('is-hidden');
  ui.menu.classList.add('is-hidden');
  ui.howto.classList.add('is-hidden');
  ui.settings.classList.add('is-hidden');
  ui.pause.classList.add('is-hidden');
  $('result-kicker').textContent = won ? 'EXPEDITION COMPLETE' : 'EXPEDITION ENDED';
  $('result-title').innerHTML = won ? 'THE TEMPLE <em>RELEASES YOU</em>' : 'LOST TO THE <em>RUINS</em>';
  $('result-copy').textContent = won
    ? `You recovered every relic and escaped with ${String(score).padStart(6, '0')} points. The story of the Lost Temple is yours to tell.`
    : `The ruins claimed your expedition. You recovered ${relics} of 3 relics and earned ${String(score).padStart(6, '0')} points.`;
  $('result-score').textContent = String(score).padStart(6, '0');
  const profile = activeSave();
  profile.expeditions++;
  profile.relicsFound += relics;
  updateAccountSummary();
  writeSave({ completedExpedition: true, recoveredRelics: relics });
  audioPing(won ? 660 : 120, .25, won ? 'triangle' : 'sawtooth', .06);
}

function onKeyDown(event) {
  const key = keyForEvent(event);
  if (!key) return;
  if (state === 'playing' && (key.startsWith('arrow') || key === ' ')) event.preventDefault();
  if (state === 'playing') keys[key] = true;
  if (event.repeat) return;
  if (key === 'h') {
    returnHome();
    return;
  }
  if (key === 'escape') {
    returnHome();
    return;
  }
  if (key === 'p') {
    if (state === 'playing') pauseGame();
    else if (state === 'paused') resumeGame();
  }
  if ((key === 'e' || key === 'enter') && state === 'playing') interact();
}

function onKeyUp(event) {
  const key = keyForEvent(event);
  if (key) keys[key] = false;
}

function keyForEvent(event) {
  if (event.code === 'KeyW') return 'w';
  if (event.code === 'KeyA') return 'a';
  if (event.code === 'KeyS') return 's';
  if (event.code === 'KeyD') return 'd';
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') return 'shift';
  if (event.code === 'Space') return ' ';
  if (event.code === 'Escape') return 'escape';
  if (event.code === 'KeyP') return 'p';
  if (event.code === 'KeyH') return 'h';
  if (event.code === 'KeyE') return 'e';
  if (event.code === 'Enter') return 'enter';
  if (event.code === 'ArrowUp' || event.code === 'ArrowDown' || event.code === 'ArrowLeft' || event.code === 'ArrowRight') return event.code.toLowerCase();
  const key = event.key.toLowerCase();
  return ['w', 'a', 's', 'd', 'shift', ' ', 'escape', 'p', 'h', 'e', 'enter', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key) ? key : null;
}

function setupTouchControls() {
  const zone = $('move-stick');
  const knob = zone.querySelector('.stick-knob');
  zone.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    stick.active = true;
    stick.pointerId = event.pointerId;
    joystickOrigin = { x: event.clientX, y: event.clientY };
    zone.setPointerCapture(event.pointerId);
    updateStick(event, zone, knob);
  });
  zone.addEventListener('pointermove', (event) => {
    if (stick.active && event.pointerId === stick.pointerId) updateStick(event, zone, knob);
  });
  const reset = (event) => {
    if (event.pointerId !== stick.pointerId) return;
    stick.active = false;
    stick.x = 0;
    stick.y = 0;
    stick.pointerId = null;
    knob.style.transform = 'translate(-50%, -50%)';
  };
  zone.addEventListener('pointerup', reset);
  zone.addEventListener('pointercancel', reset);

  bindTouchButton($('mobile-jump'), 'jump');
  bindTouchButton($('mobile-interact'), 'interact');
  bindTouchButton($('mobile-sprint'), 'sprint');
}

function updateStick(event, zone, knob) {
  const rect = zone.getBoundingClientRect();
  const dx = event.clientX - joystickOrigin.x;
  const dy = event.clientY - joystickOrigin.y;
  const max = rect.width * .34;
  const distance = Math.hypot(dx, dy);
  const scale = distance > max ? max / distance : 1;
  const x = dx * scale;
  const y = dy * scale;
  stick.x = x / max;
  stick.y = y / max;
  knob.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
}

function bindTouchButton(button, action) {
  const press = (event) => {
    event.preventDefault();
    mobileButtons[action] = true;
    if (action === 'interact') interact();
  };
  const release = () => { mobileButtons[action] = false; };
  button.addEventListener('pointerdown', press);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('pointerleave', release);
}

function movementInput() {
  const forward = (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0) - stick.y;
  const side = (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0) + stick.x;
  const length = Math.hypot(forward, side);
  return length > 1 ? { forward: forward / length, side: side / length } : { forward, side };
}

function update(dt) {
  if (state !== 'playing') {
    elapsed += dt;
    updateWorld(dt);
    return;
  }
  elapsed += dt;
  invulnerable = Math.max(0, invulnerable - dt);
  const input = movementInput();
  const sprinting = keys.shift || mobileButtons.sprint;
  const speed = sprinting ? 9 : 5.8;
  const moveX = input.side;
  const moveZ = -input.forward;
  const dx = moveX * speed * dt;
  const dz = moveZ * speed * dt;
  player.speed = Math.hypot(dx, dz) / Math.max(dt, .001);
  if (player.speed > .1) {
    const nextX = player.x + dx;
    if (!collides(nextX, player.z)) player.x = nextX;
    const nextZ = player.z + dz;
    if (!collides(player.x, nextZ)) player.z = nextZ;
    player.yaw = Math.atan2(-moveX, -moveZ);
  }
  player.x = clamp(player.x, -38.5, 38.5);
  player.z = clamp(player.z, -38.5, 38.5);

  if ((keys[' '] || mobileButtons.jump) && grounded) {
    jumpVelocity = 7.1;
    grounded = false;
    audioPing(210, .07, 'triangle', .025);
  }
  if (!grounded) {
    jumpVelocity -= 17 * dt;
    player.y += jumpVelocity * dt;
    if (player.y <= 0) {
      player.y = 0;
      jumpVelocity = 0;
      grounded = true;
    }
  }
  syncPlayerMesh();
  if (playerParts) {
    const stride = player.speed > .1 ? Math.sin(elapsed * (sprinting ? 15 : 10)) * .42 : 0;
    for (const limb of playerParts.limbs) {
      limb.leg.rotation.x = stride * limb.side;
      limb.arm.rotation.x = -stride * limb.side * .7;
    }
  }
  updateWorld(dt);
  checkTriggers();
  updatePrompt();
  updateHud();

  if (health <= 0) finishGame(false);
}

function updateWorld(dt) {
  for (const torch of torches) {
    const flicker = Math.sin(elapsed * 12 + torch.phase) * .11 + Math.sin(elapsed * 23 + torch.phase) * .06;
    torch.flame.position.y = torch.baseY + flicker;
    torch.core.position.y = torch.baseY + flicker * .8;
    torch.light.intensity = 19 + Math.sin(elapsed * 16 + torch.phase) * 3 + Math.sin(elapsed * 7) * 2;
  }
  for (const trap of traps) {
    trap.phase = (elapsed + trap.pulse) % 3.8;
    trap.active = trap.phase > 1.65 && trap.phase < 2.45;
    trap.cooldown = Math.max(0, trap.cooldown - dt);
    if (trap.spikes) trap.spikes.forEach((spike, index) => {
      const raised = trap.active ? .34 : 0;
      spike.position.y = -.45 + raised;
      spike.material.color.setHex(trap.active ? 0xc5a083 : 0x938a72);
      spike.rotation.y += dt * (index % 2 ? .15 : -.1);
    });
    if (trap.plate) trap.plate.material.color.setHex(trap.active ? 0x8e6448 : 0x68644f);
  }
  for (const pickup of pickups) {
    if (pickup.collected) continue;
    if (pickup.mesh) {
      const motion = settings.reducedMotion ? .035 : .13;
      pickup.mesh.position.y = (pickup.kind === 'relic' ? .95 : .68) + Math.sin(elapsed * 2.1 + pickup.phase) * motion;
      if (!settings.reducedMotion) {
        pickup.mesh.rotation.y += dt * (pickup.kind === 'relic' ? .65 : 1.1);
        pickup.mesh.rotation.x = Math.sin(elapsed + pickup.phase) * .14;
      }
    }
  }
  for (const chest of chests) {
    if (!chest.opened && chest.group) chest.group.position.y = Math.sin(elapsed * 1.7 + chest.phase) * .035;
  }
  if (exitGate && !exitGate.open && relics >= 3) {
    exitGate.open = true;
    if (exitGate.mesh) exitGate.mesh.visible = false;
    solidRects = solidRects.filter((rect) => !(Math.abs(rect.x) < .01 && Math.abs(rect.z + 32) < .01));
    showToast('THE NORTHERN SEAL IS BROKEN');
    for (let i = 0; i < 18; i++) addParticle(random() * 3 - 1.5, 1 + random() * 3, -31.8, 0xc7a050);
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const particle = particles[i];
    particle.life -= dt;
    if (particle.life <= 0) {
      worldRoot.remove(particle.mesh);
      particles.splice(i, 1);
      continue;
    }
    particle.mesh.position.x += particle.vx * dt;
    particle.mesh.position.y += particle.vy * dt;
    particle.mesh.position.z += particle.vz * dt;
    particle.mesh.material.opacity = clamp(particle.life / particle.maxLife, 0, 1);
  }
}

function checkTriggers() {
  for (const pickup of pickups) {
    if (pickup.collected || distance(player.x, player.z, pickup.x, pickup.z) > (pickup.kind === 'relic' ? 1.65 : 1.15)) continue;
    pickup.collected = true;
    if (pickup.mesh) pickup.mesh.visible = false;
    if (pickup.kind === 'relic') {
      relics++;
      score += 750;
      showToast(`ANCIENT RELIC RECOVERED  ·  ${relics}/3`);
      audioPing(640, .22, 'sine', .075);
      for (let i = 0; i < 12; i++) addParticle(pickup.x, 1 + random(), pickup.z, 0x70e4d1);
    } else {
      score += pickup.kind === 'gem' ? 100 : 35;
      audioPing(pickup.kind === 'gem' ? 520 : 420, .08, 'sine', .04);
      if (pickup.kind === 'gem') showToast('TEMPLE GEM  +100');
    }
    updateHud();
  }

  for (const trap of traps) {
    if (!trap.active || trap.cooldown > 0 || player.y > .34 || distance(player.x, player.z, trap.x, trap.z) > 1.38) continue;
    trap.cooldown = 1.4;
    damage(34);
  }

  if (exitGate?.open && distance(player.x, player.z, exitGate.x, exitGate.z - 1.2) < 2) finishGame(true);
}

function damage(amount) {
  if (invulnerable > 0) return;
  health = Math.max(0, health - amount);
  invulnerable = 1.1;
  if (playerParts) playerParts.group.traverse((object) => {
    if (object.isMesh && object.material.color) object.material.color.setHex(0xd16f5c);
  });
  window.setTimeout(() => {
    if (playerParts && state !== 'victory') {
      playerParts.group.traverse((object) => {
        if (object.isMesh && object.material.color) object.material.color.setHex(object.userData.baseColor);
      });
    }
  }, 230);
  showToast(`SPIKE TRAP  ·  -${amount} VITALITY`);
  audioPing(105, .14, 'sawtooth', .06);
  updateHud();
}

function collides(x, z) {
  if (x < -38 || x > 38 || z < -38 || z > 38) return true;
  return solidRects.some((rect) => Math.abs(x - rect.x) < rect.hx && Math.abs(z - rect.z) < rect.hz);
}

function closestChest() {
  return chests.find((chest) => !chest.opened && distance(player.x, player.z, chest.x, chest.z) < 2.5);
}

function interact() {
  if (state !== 'playing') return;
  const chest = closestChest();
  if (chest) {
    chest.opened = true;
    if (chest.lid) {
      chest.lid.rotation.x = -.82;
      chest.lid.position.z = -.31;
      chest.lid.position.y = 1.03;
    }
    score += 300;
    chestsOpened++;
    showToast('CHEST OPENED  ·  +300');
    audioPing(730, .25, 'triangle', .065);
    for (let i = 0; i < 10; i++) addParticle(chest.x, 1 + random() * .8, chest.z, 0xffd07a);
    updateHud();
    return;
  }
  const nearby = pickups.find((pickup) => !pickup.collected && pickup.kind === 'relic' && distance(player.x, player.z, pickup.x, pickup.z) < 2);
  if (nearby) checkTriggers();
}

function updatePrompt() {
  const chest = closestChest();
  if (chest) {
    ui.prompt.textContent = 'E  ·  OPEN CHEST';
    ui.prompt.classList.add('visible');
    return;
  }
  ui.prompt.classList.remove('visible');
}

function updateHud() {
  ui.health.style.width = `${health}%`;
  ui.healthValue.textContent = String(Math.ceil(health));
  ui.relics.innerHTML = `<span class="relic-mark" aria-hidden="true"></span> ${relics} <small>/ 3</small>`;
  ui.score.textContent = String(score).padStart(6, '0');
  if (relics < 3) ui.objective.textContent = `Find the three ancient relics  ·  ${relics}/3`;
  else ui.objective.textContent = 'The northern seal is broken — reach the gate';
  ui.health.style.background = health <= 33 ? 'linear-gradient(90deg,#bf544d,#df8866)' : 'linear-gradient(90deg,#d7785c,#edb46d)';
}

function renderThree(dt) {
  if (!renderer || !camera) return;
  const sway = settings.reducedMotion ? 0 : Math.sin(elapsed * 8) * Math.min(player.speed / 30, .035);
  const target = new THREE.Vector3(player.x, 1.4 + sway, player.z);
  const cameraTarget = new THREE.Vector3(player.x, 7.6 + player.y, player.z + 8.4);
  camera.position.lerp(cameraTarget, 1 - Math.exp(-dt * 4.8));
  camera.lookAt(target);
  renderer.render(scene, camera);
}

function resize() {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 1.7);
  ui.canvas.width = Math.floor(width * dpr);
  ui.canvas.height = Math.floor(height * dpr);
  ui.canvas.style.width = `${width}px`;
  ui.canvas.style.height = `${height}px`;
  if (renderer) {
    renderer.setSize(width, height, false);
    renderer.setPixelRatio(dpr);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
}

function frame(timestamp) {
  const dt = Math.min((timestamp - (lastFrame || timestamp)) / 1000, .05);
  lastFrame = timestamp;
  update(dt);
  renderThree(dt);
  requestAnimationFrame(frame);
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), 1900);
}

function startAmbience() {
  if (!settings.sound || !window.AudioContext) return;
  if (!audioContext) {
    audioContext = new AudioContext();
    masterGain = audioContext.createGain();
    masterGain.gain.value = .2;
    masterGain.connect(audioContext.destination);
  }
  audioContext.resume();
  if (ambience) return;
  const low = audioContext.createOscillator();
  const high = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();
  low.type = 'sine';
  low.frequency.value = 52;
  high.type = 'sine';
  high.frequency.value = 78;
  filter.type = 'lowpass';
  filter.frequency.value = 180;
  gain.gain.value = .04;
  low.connect(filter);
  high.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  low.start();
  high.start();
  ambience = { low, high, gain };
}

function stopAmbience() {
  if (!ambience) return;
  ambience.gain.gain.setTargetAtTime(0, audioContext.currentTime, .12);
  const old = ambience;
  ambience = null;
  window.setTimeout(() => {
    try { old.low.stop(); old.high.stop(); } catch (error) { console.warn('Could not stop ambient audio cleanly.', error); }
  }, 500);
}

function audioPing(frequency, duration, type, volume) {
  if (!settings.sound || !window.AudioContext) return;
  try {
    if (!audioContext) startAmbience();
    if (audioContext.state === 'suspended') audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, frequency * .72), audioContext.currentTime + duration);
    gain.gain.setValueAtTime(volume, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(masterGain);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + duration);
  } catch (error) {
    console.warn('Could not play an expedition sound.', error);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(x1, z1, x2, z2) {
  return Math.hypot(x1 - x2, z1 - z2);
}

boot();
