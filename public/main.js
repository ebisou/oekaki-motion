/**
 * おえかきモーション - Main Game Engine
 * MediaPipe (Pose & SelfieSegmentation) + Matter.js + PeerJS + Web Audio API
 */

// ==========================================
// 1. SOUND ENGINE (Web Audio API)
// ==========================================
class SoundEngine {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  // 加点SE: ピコーン (880Hz -> 1760Hz Chime)
  playScoreSound() {
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';

    // 2-tone pitch sweep
    osc1.frequency.setValueAtTime(880, now); // A5
    osc1.frequency.setValueAtTime(1760, now + 0.08); // A6
    osc2.frequency.setValueAtTime(1320, now); 
    osc2.frequency.setValueAtTime(2640, now + 0.08); 

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.35);
    osc2.stop(now + 0.35);
  }

  // お邪魔SE: ブブー (150Hz Buzz)
  playObstacleSound() {
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.linearRampToValueAtTime(110, now + 0.25);

    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.3);
  }

  // ゲームオーバーSE: ファンファーレ
  playGameOverSound() {
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const startTime = now + idx * 0.1;

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.3, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.4);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + 0.4);
    });
  }
}

const audio = new SoundEngine();

// ==========================================
// 2. MAIN APP CONTROLLER & STATE
// ==========================================
class App {
  constructor() {
    this.urlParams = new URLSearchParams(window.location.search);
    this.mode = this.urlParams.get('mode'); // 'score' | 'obstacle' | null
    this.roomId = this.urlParams.get('room') || this.generateRoomId();
    
    // Game State
    this.score = 0;
    this.timer = 60;
    this.timerInterval = null;
    this.isPlaying = false;
    this.currentTheme = 'sea'; // 'sea' | 'grass' | 'space'
    
    // PeerJS
    this.peer = null;
    this.peerConnections = [];

    // DOM Elements
    this.pcView = document.getElementById('pc-view');
    this.mobileView = document.getElementById('mobile-view');

    // Init depending on route
    if (this.mode) {
      this.initMobileView();
    } else {
      this.initPCView();
    }
  }

  generateRoomId() {
    return 'room-' + Math.random().toString(36).substring(2, 8);
  }

  // ==========================================
  // 3. PC VIEW IMPLEMENTATION
  // ==========================================
  initPCView() {
    this.pcView.style.display = 'flex';
    this.mobileView.style.display = 'none';

    // Canvas & Setup
    this.canvas = document.getElementById('game-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.video = document.getElementById('webcam-video');

    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());

    // Setup QR Codes
    this.setupQRCodes();

    // Setup Matter.js Physics Engine
    this.setupPhysics();

    // Setup MediaPipe
    this.setupMediaPipe();

    // Setup Controls & UI Events
    this.setupPCEvents();

    // Initialize PeerJS Host
    this.initPCHostPeer();

    // Spawn initial demo physics items for immediate playability
    this.spawnDemoItems();
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const container = this.canvas.parentElement;
    this.canvas.width = container.clientWidth;
    this.canvas.height = container.clientHeight;

    if (this.physicsEngine) {
      this.updatePhysicsBoundaries();
    }
  }

  // Matter.js Setup
  setupPhysics() {
    const Engine = Matter.Engine,
          World = Matter.World,
          Bodies = Matter.Bodies,
          Events = Matter.Events;

    this.physicsEngine = Engine.create({
      enableSleeping: false
    });

    this.physicsWorld = this.physicsEngine.world;
    this.physicsWorld.gravity.y = 0.15; // Default Sea gravity

    this.physicsItems = [];
    this.playerSensors = []; // Hand/Foot sensor bodies attached to MediaPipe landmarks

    // Create boundaries
    this.updatePhysicsBoundaries();

    // Physics Collision Listener
    Events.on(this.physicsEngine, 'collisionStart', (event) => {
      event.pairs.forEach((pair) => {
        const { bodyA, bodyB } = pair;
        const item = bodyA.gameMeta ? bodyA : (bodyB.gameMeta ? bodyB : null);
        const sensor = bodyA.isPlayerSensor ? bodyA : (bodyB.isPlayerSensor ? bodyB : null);

        if (item && sensor && item.gameMeta && !item.gameMeta.hit) {
          item.gameMeta.hit = true;
          this.handleItemHit(item);
        }
      });
    });
  }

  updatePhysicsBoundaries() {
    const { width, height } = this.canvas;
    const thickness = 100;
    const Bodies = Matter.Bodies;
    const World = Matter.World;

    if (this.boundaries) {
      World.remove(this.physicsWorld, this.boundaries);
    }

    this.boundaries = [
      // Floor
      Bodies.rectangle(width / 2, height + thickness / 2, width * 2, thickness, { isStatic: true, label: 'Floor' }),
      // Ceiling
      Bodies.rectangle(width / 2, -thickness / 2, width * 2, thickness, { isStatic: true, label: 'Ceiling' }),
      // Left Wall
      Bodies.rectangle(-thickness / 2, height / 2, thickness, height * 2, { isStatic: true, label: 'LeftWall' }),
      // Right Wall
      Bodies.rectangle(width + thickness / 2, height / 2, thickness, height * 2, { isStatic: true, label: 'RightWall' })
    ];

    World.add(this.physicsWorld, this.boundaries);
  }

  setTheme(theme) {
    this.currentTheme = theme;
    const toast = document.getElementById('theme-toast');
    const toastIcon = document.getElementById('theme-toast-icon');
    const toastText = document.getElementById('theme-toast-text');

    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === theme);
    });

    if (theme === 'sea') {
      this.physicsWorld.gravity.y = 0.15;
      this.physicsWorld.gravity.x = 0;
      toastIcon.className = 'fa-solid fa-water';
      toastText.textContent = '海モード (低重力・ふわふわ浮遊)';
    } else if (theme === 'grass') {
      this.physicsWorld.gravity.y = 1.0;
      this.physicsWorld.gravity.x = 0;
      toastIcon.className = 'fa-solid fa-tree';
      toastText.textContent = '草原モード (標準重力・高反発バウンド)';
    } else if (theme === 'space') {
      this.physicsWorld.gravity.y = 0.0;
      this.physicsWorld.gravity.x = 0;
      toastIcon.className = 'fa-solid fa-user-astronaut';
      toastText.textContent = '宇宙モード (無重力・中央推進)';
    }

    toast.style.opacity = '1';
    setTimeout(() => { toast.style.opacity = '0.8'; }, 2000);
  }

  // Create Physics Item from Base64 Image or Canvas
  spawnItem(imageUrl, isScoreItem = true, shape = 'circle') {
    const Bodies = Matter.Bodies;
    const World = Matter.World;
    const Body = Matter.Body;

    const x = Math.random() * (this.canvas.width - 200) + 100;
    const y = 80;
    const size = 60; // diameter or width

    let body;
    if (shape === 'square') {
      body = Bodies.rectangle(x, y, size, size, {
        restitution: this.currentTheme === 'grass' ? 0.9 : 0.6,
        frictionAir: this.currentTheme === 'sea' ? 0.04 : 0.01,
        density: 0.002
      });
    } else {
      body = Bodies.circle(x, y, size / 2, {
        restitution: this.currentTheme === 'grass' ? 0.95 : 0.7,
        frictionAir: this.currentTheme === 'sea' ? 0.03 : 0.01,
        density: 0.002
      });
    }

    // Load Image for rendering texture
    const img = new Image();
    img.src = imageUrl;

    body.gameMeta = {
      isScore: isScoreItem,
      points: isScoreItem ? 100 : -50,
      image: img,
      shape: shape,
      size: size,
      hit: false
    };

    // If Space theme, apply velocity vector towards center
    if (this.currentTheme === 'space') {
      const centerX = this.canvas.width / 2;
      const centerY = this.canvas.height / 2;
      const angle = Math.atan2(centerY - y, centerX - x);
      const speed = 4;
      Body.setVelocity(body, {
        x: Math.cos(angle) * speed,
        y: Math.sin(angle) * speed
      });
    }

    this.physicsItems.push(body);
    World.add(this.physicsWorld, body);
  }

  // Generate default canvas demo items if user hasn't sent phone photos yet
  spawnDemoItems() {
    const createDemoCanvas = (text, isScore) => {
      const cvs = document.createElement('canvas');
      cvs.width = 120;
      cvs.height = 120;
      const ctx = cvs.getContext('2d');
      ctx.fillStyle = isScore ? '#00ff66' : '#ff007f';
      ctx.beginPath();
      ctx.arc(60, 60, 56, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 36px Outfit';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 60, 60);

      return cvs.toDataURL();
    };

    // Spawn 2 score items & 1 obstacle item
    this.spawnItem(createDemoCanvas('⭐', true), true, 'circle');
    this.spawnItem(createDemoCanvas('💎', true), true, 'circle');
    this.spawnItem(createDemoCanvas('💣', false), false, 'circle');
  }

  handleItemHit(item) {
    const meta = item.gameMeta;
    if (meta.isScore) {
      this.score += meta.points;
      audio.playScoreSound();
    } else {
      this.score += meta.points; // subtracts 50
      audio.playObstacleSound();
    }

    document.getElementById('score-display').textContent = this.score;

    // Show floating score popup animation
    this.createScorePopup(item.position.x, item.position.y, meta.points);

    // Remove from physics world
    Matter.World.remove(this.physicsWorld, item);
    this.physicsItems = this.physicsItems.filter(i => i !== item);

    // Respawn new item after short delay
    setTimeout(() => {
      if (this.isPlaying) {
        this.spawnDemoItems();
      }
    }, 1500);
  }

  createScorePopup(x, y, points) {
    const popup = document.createElement('div');
    popup.className = `floating-score ${points > 0 ? 'plus' : 'minus'}`;
    popup.textContent = points > 0 ? `+${points}` : `${points}`;
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
    this.canvas.parentElement.appendChild(popup);

    setTimeout(() => popup.remove(), 1000);
  }

  // Setup MediaPipe Selfie Segmentation & Pose
  setupMediaPipe() {
    // 1. Selfie Segmentation Setup
    if (window.SelfieSegmentation) {
      this.segmentation = new SelfieSegmentation({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
      });
      this.segmentation.setOptions({
        modelSelection: 1
      });
      this.segmentation.onResults((results) => {
        this.latestSegmentationResults = results;
      });
    }

    // 2. Pose Setup (numPoses: 4)
    if (window.Pose) {
      this.pose = new Pose({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
      });
      this.pose.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
        numPoses: 4
      });
      this.pose.onResults((results) => {
        this.latestPoseResults = results;
      });
    }

    // Start Webcam
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false })
        .then((stream) => {
          this.video.srcObject = stream;
          this.video.play();
          this.startRenderLoop();
        })
        .catch((err) => {
          console.warn("Camera access warning:", err);
          // Start render loop even without camera (shows synth background & physics)
          this.startRenderLoop();
        });
    } else {
      this.startRenderLoop();
    }
  }

  // Render & Physics Loop
  startRenderLoop() {
    let lastTime = performance.now();

    const loop = (now) => {
      const delta = now - lastTime;
      lastTime = now;

      // Send video frames to MediaPipe if video is playing
      if (this.video && this.video.readyState >= 2) {
        if (this.segmentation) this.segmentation.send({ image: this.video });
        if (this.pose) this.pose.send({ image: this.video });
      }

      // Update Matter.js Engine
      Matter.Engine.update(this.physicsEngine, Math.min(delta, 33));

      // Draw Main Canvas
      this.drawCanvas();

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  // Unified Single Canvas Compositing
  drawCanvas() {
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.ctx.clearRect(0, 0, width, height);

    // 1. Draw Theme Background first
    this.drawThemeBackground(width, height);

    // 2. Draw Mirrored Person with Selfie Segmentation cut-out
    if (this.latestSegmentationResults && this.video && this.video.readyState >= 2) {
      if (!this.offscreenCanvas) {
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCtx = this.offscreenCanvas.getContext('2d');
      }
      if (this.offscreenCanvas.width !== width || this.offscreenCanvas.height !== height) {
        this.offscreenCanvas.width = width;
        this.offscreenCanvas.height = height;
      }

      const oCtx = this.offscreenCtx;
      oCtx.clearRect(0, 0, width, height);

      // Draw mask & video mirrored onto offscreen canvas
      oCtx.save();
      oCtx.translate(width, 0);
      oCtx.scale(-1, 1);
      
      // Draw segmentation mask (white silhouette on transparent canvas)
      oCtx.drawImage(this.latestSegmentationResults.segmentationMask, 0, 0, width, height);
      
      // Crop video into silhouette
      oCtx.globalCompositeOperation = 'source-in';
      oCtx.drawImage(this.video, 0, 0, width, height);
      oCtx.restore();

      // Draw the mirrored person cut-out onto main canvas over theme background!
      this.ctx.drawImage(this.offscreenCanvas, 0, 0, width, height);
    } else if (this.video && this.video.readyState >= 2) {
      // Fallback: draw mirrored full video stream if segmentation not ready yet
      this.ctx.save();
      this.ctx.translate(width, 0);
      this.ctx.scale(-1, 1);
      this.ctx.drawImage(this.video, 0, 0, width, height);
      this.ctx.restore();
    }

    // 2. Draw 4-Player Pose Skeleton Landmarks & update physical hand/foot sensors
    this.drawPoseLandmarks(width, height);

    // 3. Draw Matter.js Physics Items
    this.drawPhysicsItems();
  }

  drawThemeBackground(w, h) {
    if (this.currentTheme === 'sea') {
      const grad = this.ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#021B38');
      grad.addColorStop(1, '#084F8C');
      this.ctx.fillStyle = grad;
      this.ctx.fillRect(0, 0, w, h);

      // Soft water bubbles
      const time = Date.now() * 0.001;
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      for (let i = 0; i < 8; i++) {
        const bx = (Math.sin(time + i) * 0.5 + 0.5) * w;
        const by = ((time * 30 + i * 100) % h);
        this.ctx.beginPath();
        this.ctx.arc(bx, h - by, 12 + i * 4, 0, Math.PI * 2);
        this.ctx.fill();
      }
    } else if (this.currentTheme === 'grass') {
      const grad = this.ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#0F3818');
      grad.addColorStop(1, '#1E6B2E');
      this.ctx.fillStyle = grad;
      this.ctx.fillRect(0, 0, w, h);
    } else if (this.currentTheme === 'space') {
      this.ctx.fillStyle = '#050714';
      this.ctx.fillRect(0, 0, w, h);

      // Starfield
      this.ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 40; i++) {
        const sx = (i * 97) % w;
        const sy = (i * 131) % h;
        this.ctx.fillRect(sx, sy, 2, 2);
      }
    }
  }

  drawPoseLandmarks(w, h) {
    const playerColors = ['#00f3ff', '#ff007f', '#00ff66', '#ffe600'];
    
    // Clear previous sensor bodies
    if (this.playerSensors && this.playerSensors.length > 0) {
      this.playerSensors.forEach(sensor => Matter.World.remove(this.physicsWorld, sensor));
      this.playerSensors = [];
    }

    if (!this.latestPoseResults || !this.latestPoseResults.poseLandmarks) return;

    // MediaPipe supports poseLandmarks or poseMultiLandmarks
    const poses = this.latestPoseResults.poseMultiLandmarks || [this.latestPoseResults.poseLandmarks];

    poses.forEach((landmarks, poseIdx) => {
      if (poseIdx >= 4) return; // Up to 4 players
      const color = playerColors[poseIdx];

      // Draw Joint Connectors inside mirrored canvas context
      this.ctx.save();
      this.ctx.translate(w, 0);
      this.ctx.scale(-1, 1);
      if (window.drawConnectors && window.POSE_CONNECTIONS) {
        drawConnectors(this.ctx, landmarks, POSE_CONNECTIONS, { color: color, lineWidth: 4 });
      }
      this.ctx.restore();

      // Key Sensor Landmarks (Left/Right Wrist, Left/Right Ankle, Nose)
      const sensorIndices = [15, 16, 27, 28, 0]; // Wrists, Ankles, Nose
      const Bodies = Matter.Bodies;
      const World = Matter.World;

      landmarks.forEach((lm, idx) => {
        // Compute mirrored screen coordinates: (1 - lm.x) * w
        const lx = (1 - lm.x) * w;
        const ly = lm.y * h;

        // Draw Joint Point
        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        this.ctx.arc(lx, ly, 8, 0, Math.PI * 2);
        this.ctx.fill();

        // If Key limb joint, attach physical sensor body at mirrored position for slapping items!
        if (sensorIndices.includes(idx)) {
          const sensor = Bodies.circle(lx, ly, 25, {
            isStatic: true,
            isSensor: true,
            label: `Player_${poseIdx}_Joint_${idx}`
          });
          sensor.isPlayerSensor = true;
          this.playerSensors.push(sensor);
          World.add(this.physicsWorld, sensor);

          // Glowing aura on hands/feet
          this.ctx.strokeStyle = color;
          this.ctx.lineWidth = 2;
          this.ctx.beginPath();
          this.ctx.arc(lx, ly, 22, 0, Math.PI * 2);
          this.ctx.stroke();
        }
      });
    });
  }

  drawPhysicsItems() {
    this.physicsItems.forEach((body) => {
      const { x, y } = body.position;
      const meta = body.gameMeta;
      if (!meta) return;

      this.ctx.save();
      this.ctx.translate(x, y);
      this.ctx.rotate(body.angle);

      const size = meta.size || 60;

      // Glow outline based on item score/obstacle type
      this.ctx.shadowColor = meta.isScore ? '#00ff66' : '#ff007f';
      this.ctx.shadowBlur = 15;

      if (meta.shape === 'circle') {
        this.ctx.beginPath();
        this.ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        this.ctx.clip();
      } else {
        this.ctx.beginPath();
        this.ctx.rect(-size / 2, -size / 2, size, size);
        this.ctx.clip();
      }

      if (meta.image && meta.image.complete) {
        this.ctx.drawImage(meta.image, -size / 2, -size / 2, size, size);
      } else {
        this.ctx.fillStyle = meta.isScore ? '#00ff66' : '#ff007f';
        this.ctx.fillRect(-size / 2, -size / 2, size, size);
      }

      this.ctx.restore();
    });
  }

  // Setup UI Control Buttons
  setupPCEvents() {
    const btnStart = document.getElementById('btn-start');
    const btnStop = document.getElementById('btn-stop');
    const btnReset = document.getElementById('btn-reset');
    const btnRestart = document.getElementById('btn-modal-restart');

    btnStart.addEventListener('click', () => this.startGame());
    btnStop.addEventListener('click', () => this.stopGame());
    btnReset.addEventListener('click', () => this.resetGame());
    btnRestart.addEventListener('click', () => {
      document.getElementById('modal-gameover').classList.remove('active');
      this.resetGame();
      this.startGame();
    });

    // Theme Selector Buttons
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const theme = e.currentTarget.dataset.theme;
        this.setTheme(theme);
      });
    });
  }

  startGame() {
    if (this.isPlaying) return;
    this.isPlaying = true;

    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-stop').disabled = false;

    audio.init();

    this.timerInterval = setInterval(() => {
      this.timer--;
      document.getElementById('timer-display').textContent = this.timer;

      if (this.timer <= 0) {
        this.gameOver();
      }
    }, 1000);
  }

  stopGame() {
    this.isPlaying = false;
    clearInterval(this.timerInterval);
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-stop').disabled = true;
  }

  resetGame() {
    this.stopGame();
    this.score = 0;
    this.timer = 60;
    document.getElementById('score-display').textContent = '0';
    document.getElementById('timer-display').textContent = '60';

    // Clear items and respawn demo
    this.physicsItems.forEach(item => Matter.World.remove(this.physicsWorld, item));
    this.physicsItems = [];
    this.spawnDemoItems();
  }

  gameOver() {
    this.stopGame();
    audio.playGameOverSound();

    document.getElementById('final-score-value').textContent = this.score;
    const rankMsg = document.getElementById('final-rank-msg');
    if (this.score >= 500) {
      rankMsg.textContent = '🏆 伝説のモーションマスター！ (Rank S)';
    } else if (this.score >= 200) {
      rankMsg.textContent = '🌟 ナイスモーション！ (Rank A)';
    } else {
      rankMsg.textContent = '👍 チャレンジありがとう！ (Rank B)';
    }

    document.getElementById('modal-gameover').classList.add('active');
  }

  // Setup QR Codes for Mobile pairing
  setupQRCodes() {
    document.getElementById('room-id-display').textContent = this.roomId;

    const baseUrl = window.location.origin + window.location.pathname;
    const scoreUrl = `${baseUrl}?mode=score&room=${this.roomId}`;
    const obstacleUrl = `${baseUrl}?mode=obstacle&room=${this.roomId}`;

    new QRCode(document.getElementById('qr-score'), {
      text: scoreUrl,
      width: 120,
      height: 120
    });

    new QRCode(document.getElementById('qr-obstacle'), {
      text: obstacleUrl,
      width: 120,
      height: 120
    });
  }

  // Host PeerJS Setup
  initPCHostPeer() {
    if (!window.Peer) return;
    const hostPeerId = `oekaki-${this.roomId}`;
    this.peer = new window.Peer(hostPeerId);

    const statusDot = document.getElementById('peer-status-dot');
    const statusText = document.getElementById('peer-status-text');

    this.peer.on('open', (id) => {
      statusText.textContent = 'P2P 待機中 (接続可能)';
    });

    this.peer.on('connection', (conn) => {
      this.peerConnections.push(conn);
      statusDot.classList.add('connected');
      statusText.textContent = `スマホ接続中 (${this.peerConnections.length}台)`;

      conn.on('data', (data) => {
        if (data && data.type === 'SPAWN_ITEM') {
          const isScore = data.mode === 'score';
          this.spawnItem(data.imageData, isScore, data.shape);
        }
      });

      conn.on('close', () => {
        this.peerConnections = this.peerConnections.filter(c => c !== conn);
        if (this.peerConnections.length === 0) {
          statusText.textContent = 'P2P 待機中 (接続可能)';
        } else {
          statusText.textContent = `スマホ接続中 (${this.peerConnections.length}台)`;
        }
      });
    });
  }

  // ==========================================
  // 4. MOBILE VIEW IMPLEMENTATION
  // ==========================================
  initMobileView() {
    this.pcView.style.display = 'none';
    this.mobileView.style.display = 'flex';

    this.selectedShape = 'circle'; // 'circle' | 'square'
    this.capturedImageData = null;

    // Header badge mode
    const badge = document.getElementById('mobile-mode-badge');
    if (this.mode === 'obstacle') {
      badge.className = 'mode-badge obstacle-mode';
      badge.innerHTML = '<i class="fa-solid fa-bomb"></i> お邪魔アイテム作成 (-50)';
    } else {
      badge.className = 'mode-badge score-mode';
      badge.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 加点アイテム作成 (+100)';
    }

    this.setupMobileCamera();
    this.setupMobileEvents();
    this.initMobileClientPeer();
  }

  setupMobileCamera() {
    const video = document.getElementById('mobile-video');
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 640, height: 640 }, audio: false })
        .then((stream) => {
          video.srcObject = stream;
        })
        .catch(() => {
          // Fallback to user facing camera
          navigator.mediaDevices.getUserMedia({ video: true, audio: false })
            .then((stream) => { video.srcObject = stream; });
        });
    }
  }

  setupMobileEvents() {
    const mask = document.getElementById('shape-overlay-mask');
    const btnCircle = document.getElementById('btn-shape-circle');
    const btnSquare = document.getElementById('btn-shape-square');

    btnCircle.addEventListener('click', () => {
      this.selectedShape = 'circle';
      btnCircle.classList.add('active');
      btnSquare.classList.remove('active');
      mask.className = 'shape-mask circle-mask';
    });

    btnSquare.addEventListener('click', () => {
      this.selectedShape = 'square';
      btnSquare.classList.add('active');
      btnCircle.classList.remove('active');
      mask.className = 'shape-mask square-mask';
    });

    // Capture Photo
    document.getElementById('btn-capture').addEventListener('click', () => {
      this.capturePhoto();
    });

    // Retake
    document.getElementById('btn-retake').addEventListener('click', () => {
      document.getElementById('btn-capture').style.display = 'inline-flex';
      document.getElementById('preview-actions').style.display = 'none';
      document.getElementById('preview-container').style.display = 'none';
    });

    // Send to PC
    document.getElementById('btn-send-item').addEventListener('click', () => {
      this.sendItemToPC();
    });
  }

  capturePhoto() {
    const video = document.getElementById('mobile-video');
    const canvas = document.getElementById('crop-canvas');
    const ctx = canvas.getContext('2d');

    const size = 300;
    canvas.width = size;
    canvas.height = size;

    // Draw video centered & cropped
    const minDim = Math.min(video.videoWidth || 640, video.videoHeight || 640);
    const sx = ((video.videoWidth || 640) - minDim) / 2;
    const sy = ((video.videoHeight || 640) - minDim) / 2;

    ctx.drawImage(video, sx, sy, minDim, minDim, 0, 0, size, size);

    // Apply shape mask cropping on Canvas
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = '#000';
    ctx.beginPath();
    if (this.selectedShape === 'circle') {
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    } else {
      ctx.rect(0, 0, size, size);
    }
    ctx.fill();

    this.capturedImageData = canvas.toDataURL('image/png');

    // Display Preview
    document.getElementById('preview-img').src = this.capturedImageData;
    document.getElementById('btn-capture').style.display = 'none';
    document.getElementById('preview-actions').style.display = 'flex';
    document.getElementById('preview-container').style.display = 'block';
  }

  initMobileClientPeer() {
    if (!window.Peer) return;
    this.peer = new window.Peer();

    const statusEl = document.getElementById('mobile-peer-status');

    this.peer.on('open', () => {
      const targetHostId = `oekaki-${this.roomId}`;
      this.conn = this.peer.connect(targetHostId);

      this.conn.on('open', () => {
        statusEl.textContent = 'PC接続完了';
        statusEl.style.color = '#00ff66';
      });

      this.conn.on('error', () => {
        statusEl.textContent = '接続エラー';
        statusEl.style.color = '#ff007f';
      });
    });
  }

  sendItemToPC() {
    if (!this.conn || !this.capturedImageData) {
      alert('PCとのP2P接続を確立中です。数秒待って再試行してください。');
      return;
    }

    this.conn.send({
      type: 'SPAWN_ITEM',
      mode: this.mode,
      shape: this.selectedShape,
      imageData: this.capturedImageData
    });

    // Reset UI back to capture state after send
    alert('アイテムをPC画面へ送信しました！');
    document.getElementById('btn-capture').style.display = 'inline-flex';
    document.getElementById('preview-actions').style.display = 'none';
    document.getElementById('preview-container').style.display = 'none';
  }
}

// Initialize Application when DOM ready
window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
