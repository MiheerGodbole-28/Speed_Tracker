'use strict';

// ═══════════════════════════════════════════════════════
// SUPABASE — same credentials as main VPL app
// ═══════════════════════════════════════════════════════
const SUPABASE_URL      = 'https://zyvtlhatscbfalwwhxqr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp5dnRsaGF0c2NiZmFsd3doeHFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzOTU4MjUsImV4cCI6MjA5MDk3MTgyNX0.BDRXE82YrwniG9iQUzH_TGfTvSIxKccRhzcRe_L8QoE';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ═══════════════════════════════════════════════════════
// DETECTION CONFIGURATION
// ═══════════════════════════════════════════════════════
const PROC_W        = 640;   // processing canvas width
const PROC_H        = 360;   // processing canvas height
const MIN_BALL_PX   = 6;     // LOWERED: fewer pixels needed (low light)
const MIN_VELOCITY  = 3;     // LOWERED: start tracking at lower speed
const MISS_LIMIT    = 18;    // INCREASED: more tolerance for ball disappearing
const MIN_PTS       = 4;     // LOWERED: fewer points needed for valid reading
const MIN_DISP_PX   = 30;    // LOWERED: less displacement required
const COOLDOWN_MS   = 800;   // SHORT: so wides/no-balls can be tracked quickly
const MIN_KMH       = 5;     // LOWERED: catch slower deliveries
const MAX_KMH       = 220;

// ─── Camera on/off state ───────────────────────────────
let cameraOn = false;  // toggled by the Camera button

// ─── Manual trigger mode ────────────────────────────────
// When ON: selfie stick remote arms tracking for ONE ball then auto-disarms.
// When OFF: fully automatic detection (original behaviour).
let manualTriggerMode = true;
let armed             = false;

// ═══════════════════════════════════════════════════════
// AUTH STATE
// ═══════════════════════════════════════════════════════
let currentUser = null;
let isAdmin     = false;

// ═══════════════════════════════════════════════════════
// TRACKER STATE
// ═══════════════════════════════════════════════════════
const STATES = { IDLE: 0, TRACKING: 1, COOLDOWN: 2, CALIBRATING: 3 };

let appState      = STATES.IDLE;
let calibration   = null;
let track         = [];
let missCount     = 0;
let frameIdx      = 0;
let prevBall      = null;
let cooldownTimer = null;
let debugMode     = false;
let cameraStream  = null;

// Calibration tap state
let calTapStep = 0;
let calPt1     = null;
let calPt2     = null;

// ═══════════════════════════════════════════════════════
// DISPLAY STATE
// ═══════════════════════════════════════════════════════
let readings        = [];
let realtimeSub     = null;
let lastReadingAt   = null;
let sinceIntervalId = null;

// ═══════════════════════════════════════════════════════
// DOM REFERENCES
// ═══════════════════════════════════════════════════════
const canvas       = document.getElementById('cam');
const ctx          = canvas.getContext('2d', { willReadFrequently: true });
const vid          = document.getElementById('vid');
const camBadge     = document.getElementById('camBadge');
const camDot       = document.getElementById('camDot');
const camBadgeTxt  = document.getElementById('camBadgeTxt');
const trackBarEl   = document.getElementById('trackBar');
const debugPanel   = document.getElementById('debugPanel');
const calInstr     = document.getElementById('calInstruction');
const calStepLabel = document.getElementById('calStepLabel');
const calStepText  = document.getElementById('calStepText');
const calDistCard  = document.getElementById('calDistCard');
const distInput    = document.getElementById('distInput');
const btnSaveCal   = document.getElementById('btnSaveCal');
const speedNumber  = document.getElementById('speedNumber');
const speedCat     = document.getElementById('speedCat');
const speedSince   = document.getElementById('speedSince');
const statFastest  = document.getElementById('statFastest');
const statAvg      = document.getElementById('statAvg');
const statCount    = document.getElementById('statCount');
const ballLog      = document.getElementById('ballLog');
const connDot      = document.getElementById('connDot');
const connTxt      = document.getElementById('connTxt');

// ═══════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async function () {

    // Guard: prevents double camera start when both getSession AND onAuthStateChange
    // fire on page load (which causes the AbortError in console).
    let adminUIShown = false;

    const { data: { session } } = await db.auth.getSession();
    if (session) {
        currentUser  = session.user;
        isAdmin      = true;
        adminUIShown = true;
        showAdminUI();
    } else {
        hideAdminUI();
    }

    db.auth.onAuthStateChange((_event, session) => {
        if (session) {
            currentUser = session.user;
            isAdmin     = true;
            if (!adminUIShown) {
                adminUIShown = true;
                showAdminUI();
            }
        } else {
            currentUser  = null;
            isAdmin      = false;
            adminUIShown = false;
            hideAdminUI();
        }
    });

    setupEventListeners();

    await loadTodaysReadings();
    subscribeToReadings();

    sinceIntervalId = setInterval(updateSince, 5000);
});

// ═══════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════
function showAdminUI() {
    document.getElementById('loginBtn').classList.add('hidden');
    document.getElementById('logoutBtn').classList.remove('hidden');
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    // Auto-start camera when admin logs in
    cameraOn = true;
    updateCameraToggleBtn();
    startCamera();
}

function hideAdminUI() {
    document.getElementById('loginBtn').classList.remove('hidden');
    document.getElementById('logoutBtn').classList.add('hidden');
    document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
    cameraOn = false;
    updateCameraToggleBtn();
    stopCamera();
}

function openLoginModal() {
    document.getElementById('loginModal').classList.remove('hidden');
}

function closeLoginModal() {
    document.getElementById('loginModal').classList.add('hidden');
    document.getElementById('loginForm').reset();
    document.getElementById('loginMessage').textContent = '';
}

async function handleLogin(e) {
    e.preventDefault();
    const email     = document.getElementById('loginEmail').value;
    const password  = document.getElementById('loginPassword').value;
    const messageEl = document.getElementById('loginMessage');

    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
        messageEl.className   = 'form-message form-message--error';
        messageEl.textContent = 'Login failed: ' + error.message;
    } else {
        messageEl.className   = 'form-message form-message--success';
        messageEl.textContent = 'Login successful!';
        setTimeout(closeLoginModal, 1000);
    }
}

async function logout() {
    stopCamera();
    await db.auth.signOut();
}

// ═══════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════
function setupEventListeners() {
    document.getElementById('loginBtn').addEventListener('click', openLoginModal);
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('closeModal').addEventListener('click', closeLoginModal);
    document.getElementById('loginForm').addEventListener('submit', handleLogin);

    document.getElementById('btnCal').addEventListener('click', startCalibration);
    document.getElementById('btnDebug').addEventListener('click', toggleDebug);
    document.getElementById('btnClear').addEventListener('click', clearSession);
    document.getElementById('btnCancelCal').addEventListener('click', cancelCalibration);
    document.getElementById('btnCancelDist').addEventListener('click', cancelCalibration);
    document.getElementById('btnTriggerMode').addEventListener('click', toggleTriggerMode);
    document.getElementById('btnCamToggle').addEventListener('click', toggleCamera);

    distInput.addEventListener('input', function () {
        btnSaveCal.disabled = !this.value || parseFloat(this.value) <= 0;
    });

    btnSaveCal.addEventListener('click', saveCalibration);
    canvas.addEventListener('click', handleCanvasTap);

    window.addEventListener('click', function (e) {
        if (e.target === document.getElementById('loginModal')) closeLoginModal();
    });

    // ─── SELFIE STICK REMOTE ────────────────────────────
    // Selfie stick remotes typically send volume up/down or Enter/Space.
    // We catch keydown for most browsers and keyup as fallback for Android.
    window.addEventListener('keydown', handleRemoteKey);
    window.addEventListener('keyup', function (e) {
        if (e.key === 'AudioVolumeUp' || e.key === 'AudioVolumeDown' ||
            e.key === 'VolumeUp'      || e.key === 'VolumeDown') {
            e.preventDefault();
            armOrFireTracking();
        }
    });
}

// ═══════════════════════════════════════════════════════
// SELFIE STICK REMOTE — key handler
// ═══════════════════════════════════════════════════════
function handleRemoteKey(e) {
    // Keys fired by selfie stick remotes (varies by brand):
    const remoteKeys = new Set([
        'Enter', ' ', 'Spacebar',
        'VolumeUp', 'VolumeDown',
        'AudioVolumeUp', 'AudioVolumeDown',
        'MediaPlayPause', 'F5', 'ArrowRight'
    ]);

    if (!remoteKeys.has(e.key)) return;
    if (!isAdmin) return;
    if (appState === STATES.CALIBRATING) return;

    e.preventDefault();
    armOrFireTracking();
}

function armOrFireTracking() {
    if (appState === STATES.COOLDOWN) {
        pulseArmButton('wait');
        return;
    }
    if (appState === STATES.TRACKING) {
        // Force finish early (ball left frame)
        finishTracking();
        return;
    }

    // ARM for next ball
    armed = true;
    setCamBadge('armed');
    pulseArmButton('armed');
}

function pulseArmButton(state) {
    const btn = document.getElementById('btnTriggerMode');
    if (!btn) return;
    if (state === 'armed') {
        btn.classList.add('armed-pulse');
        setTimeout(() => btn.classList.remove('armed-pulse'), 1000);
    } else if (state === 'wait') {
        btn.classList.add('wait-pulse');
        setTimeout(() => btn.classList.remove('wait-pulse'), 600);
    }
}

function toggleTriggerMode() {
    manualTriggerMode = !manualTriggerMode;
    const btn = document.getElementById('btnTriggerMode');
    if (manualTriggerMode) {
        btn.textContent = '🎯 Remote: ON';
        btn.classList.add('active');
        armed = false;
        if (appState === STATES.IDLE) setCamBadge('idle');
    } else {
        btn.textContent = '🤖 Auto Detect';
        btn.classList.remove('active');
        armed = false;
        if (appState === STATES.IDLE) setCamBadge('auto');
    }
}

// ═══════════════════════════════════════════════════════
// CAMERA
// ═══════════════════════════════════════════════════════
function toggleCamera() {
    cameraOn = !cameraOn;
    updateCameraToggleBtn();
    if (cameraOn) {
        startCamera();
    } else {
        stopCamera();
        setCamBadge('idle');
        // Clear the canvas to black so it's obviously off
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, canvas.width || 640, canvas.height || 360);
    }
}

function updateCameraToggleBtn() {
    const btn = document.getElementById('btnCamToggle');
    if (!btn) return;
    if (cameraOn) {
        btn.textContent = '📷 Camera: ON';
        btn.classList.add('active');
    } else {
        btn.textContent = '📷 Camera: OFF';
        btn.classList.remove('active');
    }
}

async function startCamera() {
    try {
        await requestWakeLock();
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: 'environment' },
                width:  { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 }
            },
            audio: false
        });
        vid.srcObject = cameraStream;
        await vid.play();

        document.getElementById('noCam').classList.add('hidden');
        setCamBadge('idle');

        const hasCal = loadCalibration();
        requestAnimationFrame(frameLoop);

        if (!hasCal) setTimeout(startCalibration, 1500);

    } catch (err) {
        setCamBadge('nocam');
        document.getElementById('noCam').classList.remove('hidden');
        console.error('Camera error:', err);
    }
}

function stopCamera() {
    if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
    }
    appState  = STATES.IDLE;
    track     = [];
    missCount = 0;
    prevBall  = null;
    armed     = false;
    clearTimeout(cooldownTimer);
}

// ═══════════════════════════════════════════════════════
// FRAME LOOP
// ═══════════════════════════════════════════════════════
function frameLoop() {
    if (!cameraStream || !cameraStream.active) return;
    requestAnimationFrame(frameLoop);

    if (vid.readyState < 2) return;

    frameIdx++;

    canvas.width  = PROC_W;
    canvas.height = PROC_H;
    ctx.drawImage(vid, 0, 0, PROC_W, PROC_H);

    if (calibration) drawCalOverlay();
    if (appState === STATES.TRACKING && track.length > 1) drawTrack();

    const imgData = ctx.getImageData(0, 0, PROC_W, PROC_H);
    const ball    = findBall(imgData.data);

    updateTracking(ball, performance.now());

    if (debugMode) updateDebug(ball, imgData.data);
}

// ═══════════════════════════════════════════════════════
// BALL DETECTION
// Improved for low-light / curtain-filtered sunlight.
// Two colour ranges: bright neon AND dim warm yellow.
// ═══════════════════════════════════════════════════════
function isNeonYellow(r, g, b) {
    // Classic neon yellow (outdoor / bright light)
    const neon = (
        g > 130 &&
        r > 70  &&
        b < 120 &&
        (g - b) > 60 &&
        (r + g) > 240 &&
        g >= r * 0.60
    );

    // Dim / warm yellow (indoor, curtain-filtered sun)
    const dim = (
        r > 55 && r < 230 &&
        g > 55 && g < 230 &&
        b < 110 &&
        r >= g * 0.70 &&
        g >= r * 0.60 &&
        (r + g) > 150 &&
        (r + g - 2 * b) > 70
    );

    return neon || dim;
}

function findBall(data) {
    let sx = 0, sy = 0, n = 0;
    // Sample every 2 pixels — better resolution in low light
    for (let y = 0; y < PROC_H; y += 2) {
        for (let x = 0; x < PROC_W; x += 2) {
            const i = (y * PROC_W + x) * 4;
            if (isNeonYellow(data[i], data[i+1], data[i+2])) {
                sx += x; sy += y; n++;
            }
        }
    }
    return n >= MIN_BALL_PX ? { x: sx / n, y: sy / n, size: n } : null;
}

// ═══════════════════════════════════════════════════════
// TRACKING STATE MACHINE
// ═══════════════════════════════════════════════════════
function updateTracking(ball, now) {
    if (appState === STATES.COOLDOWN || appState === STATES.CALIBRATING) return;

    if (!ball) {
        if (appState === STATES.TRACKING) {
            missCount++;
            if (missCount >= MISS_LIMIT) finishTracking();
        }
        prevBall = null;
        return;
    }

    const vel = prevBall ? Math.hypot(ball.x - prevBall.x, ball.y - prevBall.y) : 0;

    if (appState === STATES.IDLE) {
        // In manual mode: only start if armed; in auto mode: always start
        const canStart = manualTriggerMode ? armed : true;

        if (canStart && vel >= MIN_VELOCITY) {
            appState  = STATES.TRACKING;
            track     = [{ x: ball.x, y: ball.y, t: now }];
            missCount = 0;
            armed     = false; // consume the arm
            setCamBadge('tracking');
        }
    } else if (appState === STATES.TRACKING) {
        track.push({ x: ball.x, y: ball.y, t: now });
        missCount = 0;

        if (calibration) {
            const maxDx = Math.abs(calibration.p2x - calibration.p1x);
            const curDx = Math.abs(ball.x - track[0].x);
            trackBarEl.style.width = Math.min(100, (curDx / maxDx) * 100) + '%';
        }
    }

    prevBall = ball;
}

function finishTracking() {
    const speed = calcSpeed(track);
    track     = [];
    missCount = 0;
    trackBarEl.style.width = '0%';

    if (speed !== null) {
        flashSpeedOnCamera(speed);
        saveSpeedToSupabase(speed);
    }

    appState = STATES.COOLDOWN;
    setCamBadge('cooldown');
    prevBall = null;

    clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
        appState = STATES.IDLE;
        setCamBadge(manualTriggerMode ? 'idle' : 'auto');
    }, COOLDOWN_MS);
}

// ═══════════════════════════════════════════════════════
// SPEED CALCULATION
// ═══════════════════════════════════════════════════════
function calcSpeed(pts) {
    if (!calibration || pts.length < MIN_PTS) return null;

    const p0    = pts[0];
    const p1    = pts[pts.length - 1];
    const dxPx  = Math.abs(p1.x - p0.x);
    const dtMs  = p1.t - p0.t;

    if (dxPx < MIN_DISP_PX) return null;
    if (dtMs  < 20)          return null;

    const dxM      = dxPx / calibration.pxPerM;
    const speedMS  = dxM / (dtMs / 1000);
    const speedKMH = speedMS * 3.6;

    if (speedKMH < MIN_KMH || speedKMH > MAX_KMH) return null;
    return Math.round(speedKMH * 10) / 10;
}

// ═══════════════════════════════════════════════════════
// CANVAS DRAWING
// ═══════════════════════════════════════════════════════
function drawTrack() {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(248,113,113,0.9)';
    ctx.lineWidth   = 2;
    ctx.moveTo(track[0].x, track[0].y);
    for (let i = 1; i < track.length; i++) ctx.lineTo(track[i].x, track[i].y);
    ctx.stroke();

    const last = track[track.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 8, 0, Math.PI * 2);
    ctx.fillStyle   = 'rgba(248,113,113,0.55)';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 2;
    ctx.fill();
    ctx.stroke();
}

function drawCalOverlay() {
    ctx.beginPath();
    ctx.moveTo(calibration.p1x, calibration.p1y);
    ctx.lineTo(calibration.p2x, calibration.p2y);
    ctx.strokeStyle = 'rgba(192,144,32,0.45)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    [[calibration.p1x, calibration.p1y], [calibration.p2x, calibration.p2y]].forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#c09020';
        ctx.fill();
    });
}

// ═══════════════════════════════════════════════════════
// CAMERA UI HELPERS
// ═══════════════════════════════════════════════════════
const BADGE_CFG = {
    idle:     { cls: 'idle',     txt: 'Ready — Press Remote', pulse: true  },
    auto:     { cls: 'idle',     txt: 'Auto — Watching',      pulse: true  },
    armed:    { cls: 'armed',    txt: '🎯 Armed — Bowl Now!', pulse: true  },
    tracking: { cls: 'tracking', txt: 'Tracking',             pulse: true  },
    cooldown: { cls: 'cooldown', txt: 'Cooldown',             pulse: false },
    cal:      { cls: 'cal',      txt: 'Calibrate',            pulse: false },
    nocam:    { cls: 'nocam',    txt: 'No Camera',            pulse: false },
};

function setCamBadge(type) {
    const cfg = BADGE_CFG[type] || BADGE_CFG.idle;
    camBadge.className      = `cam-badge ${cfg.cls}`;
    camBadgeTxt.textContent = cfg.txt;
    camDot.className        = `cam-dot${cfg.pulse ? ' pulse' : ''}`;
}

function flashSpeedOnCamera(kmh) {
    const existing = document.getElementById('camSpeedFlash');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.className   = 'cam-speed-flash';
    el.id          = 'camSpeedFlash';
    el.textContent = kmh.toFixed(1);
    document.getElementById('cameraWrap').appendChild(el);

    setTimeout(() => { if (el.parentNode) el.remove(); }, 1200);
}

// ═══════════════════════════════════════════════════════
// CALIBRATION
// ═══════════════════════════════════════════════════════
function loadCalibration() {
    try {
        const s = localStorage.getItem('vpl_speed_cal');
        if (s) { calibration = JSON.parse(s); return true; }
    } catch (e) {}
    return false;
}

function persistCalibration(cal) {
    calibration = cal;
    localStorage.setItem('vpl_speed_cal', JSON.stringify(cal));
}

function startCalibration() {
    appState   = STATES.CALIBRATING;
    calTapStep = 1;
    calPt1 = calPt2 = null;

    document.querySelectorAll('.tap-dot').forEach(el => el.remove());

    calInstr.classList.remove('hidden');
    calDistCard.classList.add('hidden');
    calStepLabel.textContent = 'Step 1 of 2';
    calStepText.textContent  = 'Tap the bowling crease on the camera view above';

    setCamBadge('cal');
}

function cancelCalibration() {
    calTapStep = 0;
    calPt1 = calPt2 = null;
    document.querySelectorAll('.tap-dot').forEach(el => el.remove());
    calInstr.classList.add('hidden');
    calDistCard.classList.add('hidden');
    distInput.value    = '';
    btnSaveCal.disabled = true;
    appState = STATES.IDLE;
    setCamBadge('idle');
}

function handleCanvasTap(e) {
    if (calTapStep !== 1 && calTapStep !== 2) return;

    const rect   = canvas.getBoundingClientRect();
    const scaleX = PROC_W / rect.width;
    const scaleY = PROC_H / rect.height;
    const px     = (e.clientX - rect.left) * scaleX;
    const py     = (e.clientY - rect.top)  * scaleY;

    const dot = document.createElement('div');
    dot.className  = 'tap-dot';
    dot.style.left = e.clientX + 'px';
    dot.style.top  = e.clientY + 'px';
    document.body.appendChild(dot);

    if (calTapStep === 1) {
        calPt1 = { x: px, y: py };
        calTapStep = 2;
        calStepLabel.textContent = 'Step 2 of 2';
        calStepText.textContent  = 'Tap the batting crease (or any second reference point at a known distance)';
    } else {
        calPt2 = { x: px, y: py };
        calTapStep = 3;
        calInstr.classList.add('hidden');
        calDistCard.classList.remove('hidden');
        setTimeout(() => distInput.focus(), 100);
    }
}

function saveCalibration() {
    const distM  = parseFloat(distInput.value);
    if (!distM || !calPt1 || !calPt2) return;

    const pxDist = Math.hypot(calPt2.x - calPt1.x, calPt2.y - calPt1.y);
    if (pxDist < 10) {
        alert('The two points are too close together. Please try again.');
        cancelCalibration();
        return;
    }

    persistCalibration({
        p1x: calPt1.x, p1y: calPt1.y,
        p2x: calPt2.x, p2y: calPt2.y,
        distM,
        pxPerM: pxDist / distM
    });

    document.querySelectorAll('.tap-dot').forEach(el => el.remove());
    calDistCard.classList.add('hidden');
    calTapStep      = 0;
    distInput.value = '';
    btnSaveCal.disabled = true;
    appState = STATES.IDLE;
    setCamBadge('idle');
}

// ═══════════════════════════════════════════════════════
// DEBUG
// ═══════════════════════════════════════════════════════
function toggleDebug() {
    debugMode = !debugMode;
    debugPanel.classList.toggle('hidden', !debugMode);
    document.getElementById('btnDebug').classList.toggle('active', debugMode);
}

function updateDebug(ball, data) {
    let yCount = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (isNeonYellow(data[i], data[i+1], data[i+2])) yCount++;
    }
    const stateName = Object.keys(STATES).find(k => STATES[k] === appState);
    document.getElementById('d-state').textContent = stateName + (armed ? ' [ARMED]' : '');
    document.getElementById('d-ball').textContent  = ball
        ? `x:${ball.x.toFixed(0)} y:${ball.y.toFixed(0)} sz:${ball.size}`
        : 'none';
    document.getElementById('d-vel').textContent   = prevBall && ball
        ? Math.hypot(ball.x - prevBall.x, ball.y - prevBall.y).toFixed(1)
        : '-';
    document.getElementById('d-pts').textContent   = track.length;
    document.getElementById('d-px').textContent    = yCount;
    document.getElementById('d-miss').textContent  = missCount;
    document.getElementById('d-cal').textContent   = calibration
        ? calibration.pxPerM.toFixed(1) + ' px/m  (' + calibration.distM + 'm)'
        : 'not set';
}

// ═══════════════════════════════════════════════════════
// SUPABASE — save only the speed number
// ═══════════════════════════════════════════════════════
async function saveSpeedToSupabase(kmh) {
    try {
        const { error } = await db.from('speed_readings').insert({ speed_kmh: kmh });
        if (error) console.warn('Speed save failed:', error.message);
    } catch (e) {
        console.warn('Supabase error:', e);
    }
}

// ═══════════════════════════════════════════════════════
// DISPLAY — realtime subscription and rendering
// ═══════════════════════════════════════════════════════
async function loadTodaysReadings() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { data, error } = await db
        .from('speed_readings')
        .select('speed_kmh, created_at')
        .gte('created_at', startOfDay.toISOString())
        .order('created_at', { ascending: true });

    if (error) { console.warn('Load error:', error.message); return; }

    readings = data || [];

    if (readings.length > 0) {
        const latest   = readings[readings.length - 1];
        lastReadingAt  = latest.created_at;
        const fastest  = Math.max(...readings.map(r => r.speed_kmh));
        const isLatestFastest = latest.speed_kmh >= fastest;
        updateSpeedDisplay(latest.speed_kmh, isLatestFastest, false);
    }

    updateStatsDisplay();
    renderBallLog(false);
}

function subscribeToReadings() {
    realtimeSub = db
        .channel('speed-readings-live')
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'speed_readings' },
            payload => { onNewReading(payload.new); }
        )
        .subscribe(status => {
            if (status === 'SUBSCRIBED') {
                connDot.classList.add('live');
                connTxt.textContent = 'Live';
            } else {
                connDot.classList.remove('live');
                connTxt.textContent = status === 'CHANNEL_ERROR' ? 'Error' : 'Connecting';
            }
        });
}

function onNewReading(reading) {
    readings.push(reading);
    lastReadingAt = reading.created_at;

    const fastest  = Math.max(...readings.map(r => r.speed_kmh));
    const isFastest = reading.speed_kmh >= fastest;

    updateSpeedDisplay(reading.speed_kmh, isFastest, true);
    updateStatsDisplay();
    renderBallLog(true);
}

function categorise(kmh) {
    if (kmh < 50)  return { key: 'slow',   label: '🔵 Slow' };
    if (kmh < 80)  return { key: 'medium', label: '🟢 Medium' };
    if (kmh < 110) return { key: 'fast',   label: '🟡 Fast' };
    return               { key: 'rapid',  label: '🔴 Rapid' };
}

function updateSpeedDisplay(kmh, isFastest, animate) {
    speedNumber.textContent = kmh.toFixed(1);

    if (animate) {
        speedNumber.classList.remove('flash', 'fastest-flash');
        void speedNumber.offsetWidth;
        speedNumber.classList.add(isFastest ? 'fastest-flash' : 'flash');
    }

    const cat = categorise(kmh);
    speedCat.className   = `speed-cat ${cat.key}`;
    speedCat.textContent = isFastest ? '⚡ ' + cat.label + ' · NEW FASTEST' : cat.label;
    speedCat.classList.remove('hidden');

    updateSince();
}

function updateSince() {
    if (!lastReadingAt) return;
    const s = Math.floor((Date.now() - new Date(lastReadingAt).getTime()) / 1000);
    if (s < 60)        speedSince.textContent = s + 's ago';
    else if (s < 3600) speedSince.textContent = Math.floor(s / 60) + 'm ago';
    else               speedSince.textContent = Math.floor(s / 3600) + 'h ago';
}

function updateStatsDisplay() {
    if (!readings.length) {
        statFastest.textContent = '--';
        statAvg.textContent     = '--';
        statCount.textContent   = '0';
        return;
    }
    const speeds  = readings.map(r => r.speed_kmh);
    const fastest = Math.max(...speeds);
    const avg     = speeds.reduce((a, b) => a + b, 0) / speeds.length;

    statFastest.textContent = fastest.toFixed(1);
    statAvg.textContent     = avg.toFixed(1);
    statCount.textContent   = readings.length;
}

function renderBallLog(isNew) {
    if (!readings.length) {
        ballLog.innerHTML = '';
        ballLog.appendChild(makeEmptyLog());
        return;
    }

    ballLog.innerHTML = '';
    const sorted = [...readings].reverse();

    sorted.forEach((r, idx) => {
        const cat = categorise(r.speed_kmh);
        const row = document.createElement('div');
        row.className = `log-row${idx === 0 && isNew ? ' new' : ''}`;

        const d = new Date(r.created_at);
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        row.innerHTML = `
            <span class="log-ball-num">#${readings.length - idx}</span>
            <span class="log-speed-val ${cat.key}">${r.speed_kmh.toFixed(1)}</span>
            <span class="log-kmh">km/h</span>
            <span class="log-cat-badge ${cat.key}">${cat.label}</span>
            <span class="log-time">${timeStr}</span>
        `;
        ballLog.appendChild(row);
    });

    if (isNew) {
        setTimeout(() => {
            const first = ballLog.querySelector('.new');
            if (first) first.classList.remove('new');
        }, 2000);
    }
}

function makeEmptyLog() {
    const el = document.createElement('div');
    el.className = 'log-empty';
    el.innerHTML = '<div class="log-waiting-icon">⏱</div>Waiting for deliveries...';
    return el;
}

// ═══════════════════════════════════════════════════════
// CLEAR SESSION — FIX: now also clears calibration points
// ═══════════════════════════════════════════════════════
function clearSession() {
    const hasReadings    = readings.length > 0;
    const hasCalibration = calibration !== null;

    if (!hasReadings && !hasCalibration) return;

    const msg = (hasReadings && hasCalibration)
        ? 'Clear all readings AND saved calibration points?'
        : hasReadings
            ? 'Clear all readings from today\'s session?'
            : 'Clear saved calibration points?';

    if (!confirm(msg)) return;

    // Clear readings display
    readings      = [];
    lastReadingAt = null;
    speedNumber.textContent = '--';
    speedCat.classList.add('hidden');
    speedSince.textContent  = '';
    updateStatsDisplay();
    renderBallLog(false);

    // Also clear calibration & saved tap points
    calibration = null;
    localStorage.removeItem('vpl_speed_cal');
    document.querySelectorAll('.tap-dot').forEach(el => el.remove());

    // Prompt re-calibration
    if (isAdmin && cameraStream) setTimeout(startCalibration, 500);
}

// ═══════════════════════════════════════════════════════
// WAKE LOCK
// ═══════════════════════════════════════════════════════
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
    } catch (e) { /* not critical */ }
}