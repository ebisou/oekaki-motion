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
    this.spawnerTimeout = null;
    this.isPlaying = false;
    this.currentTheme = 'sea'; // 'sea' | 'grass' | 'space'
    this.currentScoreTexture = null; // Latest score item photo sent from phone
    this.currentObstacleTexture = null; // Latest obstacle item photo sent from phone
    this.currentScoreShape = 'circle';
    this.currentObstacleShape = 'circle';
    
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
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const container = this.canvas.parentElement;
    this.canvas.width = container.clientWidth;
    this.canvas.height = container.clientHeight;

    if (this.physicsEngine) {
      this.updatePhysicsBoundaries();
      if (this.currentTheme) {
        this.setTheme(this.currentTheme);
      }
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
    this.sensorPool = {}; // Persistent Pool of Hand/Foot sensor bodies attached to MediaPipe landmarks

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
    if (this.currentTheme === 'space') return; // No solid walls in Space Mode
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

    // Scale gravity non-linearly with canvas height so small mobile screens don't drop items rapidly
    const ratio = Math.min(1.0, (this.canvas.height || 720) / 720);
    const heightScale = Math.pow(ratio, 1.8);

    if (theme === 'sea') {
      this.physicsWorld.gravity.y = 0.012 * heightScale; // Ultra-gentle underwater drift
      this.physicsWorld.gravity.x = 0;
      this.updatePhysicsBoundaries();
      toastIcon.className = 'fa-solid fa-water';
      toastText.textContent = '海モード (低重力・くらげ風ゆったり浮遊)';
    } else if (theme === 'grass') {
      this.physicsWorld.gravity.y = 0.025 * heightScale; // Gentle uniform falling speed
      this.physicsWorld.gravity.x = 0;
      this.updatePhysicsBoundaries();
      toastIcon.className = 'fa-solid fa-tree';
      toastText.textContent = '草原モード (標準重力・ゆったり均一落下)';
    } else if (theme === 'space') {
      this.physicsWorld.gravity.y = 0.0;
      this.physicsWorld.gravity.x = 0;
      // Remove solid walls in space mode so items fly straight through outer borders
      if (this.boundaries) {
        Matter.World.remove(this.physicsWorld, this.boundaries);
        this.boundaries = null;
      }
      toastIcon.className = 'fa-solid fa-user-astronaut';
      toastText.textContent = '宇宙モード (全方向無減速スルー)';
    }

    toast.style.opacity = '1';
    setTimeout(() => { toast.style.opacity = '0.8'; }, 2000);
  }

  // Create Physics Item from Base64 Image or Canvas
  spawnItem(imageUrl, isScoreItem = true, shape = 'circle') {
    const Bodies = Matter.Bodies;
    const World = Matter.World;
    const Body = Matter.Body;

    const width = this.canvas.width;
    const height = this.canvas.height;

    // Proportionally scale item size based on canvas dimensions (34px-44px on mobile, 64px on PC)
    const baseDim = Math.min(width, height);
    const size = Math.max(34, Math.min(64, Math.round(baseDim * 0.09)));
    const ratio = Math.min(1.0, height / 720);
    const heightScale = Math.pow(ratio, 1.8);

    const isSpace = this.currentTheme === 'space';

    let x, y, vx, vy;

    if (isSpace) {
      // Pick one of 4 outer edges at random: 0: Top, 1: Right, 2: Bottom, 3: Left
      const side = Math.floor(Math.random() * 4);
      const speed = (Math.random() * 0.6 + 1.5) * Math.max(0.4, heightScale);

      if (side === 0) { // Top -> Flying Down
        x = Math.random() * Math.max(60, width - 120) + 60;
        y = 5;
        vx = (Math.random() - 0.5) * 0.8;
        vy = speed;
      } else if (side === 1) { // Right -> Flying Left
        x = width + 30;
        y = Math.random() * Math.max(60, height - 120) + 60;
        vx = -speed;
        vy = (Math.random() - 0.5) * 0.8;
      } else if (side === 2) { // Bottom -> Flying Up
        x = Math.random() * Math.max(60, width - 120) + 60;
        y = height + 30;
        vx = (Math.random() - 0.5) * 0.8;
        vy = -speed;
      } else { // Left -> Flying Right
        x = -30;
        y = Math.random() * Math.max(60, height - 120) + 60;
        vx = speed;
        vy = (Math.random() - 0.5) * 0.8;
      }
    } else {
      // Normal top drop for Sea and Grassland (start at y = 5 with zero initial velocity to avoid top-half acceleration burst)
      x = Math.random() * Math.max(60, width - 120) + 60;
      y = 5;
      vx = (Math.random() - 0.5) * 0.2;
      vy = 0.0; // Zero initial downward velocity for smooth top-half drift
    }

    const options = {
      restitution: this.currentTheme === 'grass' ? 0.7 : 0.5,
      frictionAir: isSpace ? 0.0 : (this.currentTheme === 'sea' ? 0.02 : 0.015),
      friction: isSpace ? 0.0 : 0.1,
      density: 0.001
    };

    let body;
    if (shape === 'square') {
      body = Bodies.rectangle(x, y, size, size, options);
    } else {
      body = Bodies.circle(x, y, size / 2, options);
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

    // Apply linear velocity vector for Space Mode
    if (isSpace) {
      Body.setVelocity(body, { x: vx, y: vy });
    }

    this.physicsItems.push(body);
    World.add(this.physicsWorld, body);
  }

  // Periodic Random Item Spawner
  spawnRandomItem() {
    if (!this.isPlaying) return;
    if (this.physicsItems.length >= 12) return; // Allow active rain of up to 12 items

    const isScore = Math.random() < 0.75; // 75% score items, 25% obstacle items
    let textureUrl = null;
    let shape = 'circle';

    if (isScore) {
      if (this.currentScoreTexture) {
        textureUrl = this.currentScoreTexture;
        shape = this.currentScoreShape || 'circle';
      } else {
        textureUrl = this.createPresetTexture('⭐', true);
        shape = Math.random() < 0.5 ? 'circle' : 'square';
      }
    } else {
      if (this.currentObstacleTexture) {
        textureUrl = this.currentObstacleTexture;
        shape = this.currentObstacleShape || 'circle';
      } else {
        textureUrl = this.createPresetTexture('💣', false);
        shape = Math.random() < 0.5 ? 'circle' : 'square';
      }
    }

    this.spawnItem(textureUrl, isScore, shape);
  }

  createPresetTexture(text, isScore) {
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
    ctx.font = 'bold 44px Outfit';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 60, 62);

    return cvs.toDataURL();
  }

  startItemSpawner() {
    this.stopItemSpawner();

    // Drop initial item immediately on start
    this.spawnRandomItem();

    const scheduleNext = () => {
      if (!this.isPlaying) return;
      // Fast drop interval: 600ms to 1300ms for continuous thrill
      const delay = Math.random() * 700 + 600;
      this.spawnerTimeout = setTimeout(() => {
        if (this.isPlaying) {
          this.spawnRandomItem();
          scheduleNext();
        }
      }, delay);
    };

    scheduleNext();
  }

  stopItemSpawner() {
    if (this.spawnerTimeout) {
      clearTimeout(this.spawnerTimeout);
      this.spawnerTimeout = null;
    }
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
    this.isProcessingSegment = false;
    this.isProcessingPose = false;

    // 1. Selfie Segmentation Setup
    if (window.SelfieSegmentation) {
      try {
        this.segmentation = new window.SelfieSegmentation({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
        });
        this.segmentation.setOptions({
          modelSelection: 1 // 1: Landscape model for wide/full-body view
        });
        this.segmentation.onResults((results) => {
          this.latestSegmentationResults = results;
          this.isProcessingSegment = false;
        });
      } catch (err) {
        console.warn("SelfieSegmentation init warning:", err);
      }
    }

    // 2. Pose Setup (Head & Feet Tracking)
    if (window.Pose) {
      try {
        this.pose = new window.Pose({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
        });
        this.pose.setOptions({
          modelComplexity: 1,
          smoothLandmarks: true,
          enableSegmentation: false,
          minDetectionConfidence: 0.4,
          minTrackingConfidence: 0.4
        });
        this.pose.onResults((results) => {
          this.latestPoseResults = results;
          this.isProcessingPose = false;
        });
      } catch (err) {
        console.warn("Pose init warning:", err);
      }
    }

    // 3. Hands Setup (Multi-Hand Tracking for up to 6 hands / multi-player 2+ players!)
    this.isProcessingHands = false;
    if (window.Hands) {
      try {
        this.hands = new window.Hands({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
        });
        this.hands.setOptions({
          maxNumHands: 6,
          modelComplexity: 1,
          minDetectionConfidence: 0.35,
          minTrackingConfidence: 0.35
        });
        this.hands.onResults((results) => {
          this.latestHandsResults = results;
          this.isProcessingHands = false;
        });
      } catch (err) {
        console.warn("Hands init warning:", err);
      }
    }

    // Start Webcam (default facingMode: user for front camera on smartphones / laptops)
    this.currentCameraFacing = 'user';
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: this.currentCameraFacing, width: 1280, height: 720 }, audio: false })
        .then((stream) => {
          this.webcamStream = stream;
          this.video.srcObject = stream;
          this.video.play();
          this.startRenderLoop();
        })
        .catch((err) => {
          console.warn("Camera access warning:", err);
          this.startRenderLoop();
        });
    } else {
      this.startRenderLoop();
    }
  }

  toggleWebcam() {
    this.currentCameraFacing = (this.currentCameraFacing === 'user') ? 'environment' : 'user';
    if (this.webcamStream) {
      this.webcamStream.getTracks().forEach(track => track.stop());
    }

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.currentCameraFacing, width: 1280, height: 720 },
        audio: false
      })
      .then((stream) => {
        this.webcamStream = stream;
        this.video.srcObject = stream;
        this.video.play();
      })
      .catch((err) => {
        console.warn("Camera toggle warning:", err);
      });
    }
  }

  // Render & Physics Loop
  startRenderLoop() {
    let lastTime = performance.now();
    let physicsAccumulator = 0;
    const fixedTimestep = 1000 / 60; // Fixed 60Hz timestep (16.66ms) to prevent 120Hz mobile screens from running 2x fast!

    const loop = (now) => {
      const delta = Math.min(now - lastTime, 100);
      lastTime = now;

      // Send video frames to MediaPipe engines safely
      if (this.video && this.video.readyState >= 2) {
        if (this.segmentation && !this.isProcessingSegment) {
          this.isProcessingSegment = true;
          this.segmentation.send({ image: this.video }).catch(() => { this.isProcessingSegment = false; });
        }
        if (this.pose && !this.isProcessingPose) {
          this.isProcessingPose = true;
          this.pose.send({ image: this.video }).catch(() => { this.isProcessingPose = false; });
        }
        if (this.hands && !this.isProcessingHands) {
          this.isProcessingHands = true;
          this.hands.send({ image: this.video }).catch(() => { this.isProcessingHands = false; });
        }
      }

      // Update Matter.js Engine with fixed 60Hz accumulator
      if (this.isPlaying) {
        physicsAccumulator += delta;

        // Scale max speed limit relative to screen height
        const heightScale = Math.max(0.3, Math.min(1.0, (this.canvas.height || 720) / 720));
        const maxVy = this.currentTheme === 'sea' ? (1.0 * heightScale) : (1.6 * heightScale);

        while (physicsAccumulator >= fixedTimestep) {
          // Clamp downward falling speed so items never shoot down fast on any device
          if (this.currentTheme !== 'space' && this.physicsItems) {
            this.physicsItems.forEach((body) => {
              if (body.velocity.y > maxVy) {
                Matter.Body.setVelocity(body, { x: body.velocity.x, y: maxVy });
              }
            });
          }

          Matter.Engine.update(this.physicsEngine, fixedTimestep);
          physicsAccumulator -= fixedTimestep;
        }

        // Auto-remove items that fell past the floor or flew offscreen
        const margin = 150;
        this.physicsItems.forEach((body) => {
          if (
            body.position.y > this.canvas.height + margin ||
            body.position.y < -margin * 2 ||
            body.position.x < -margin ||
            body.position.x > this.canvas.width + margin
          ) {
            Matter.World.remove(this.physicsWorld, body);
            body.isDead = true;
          }
        });
        this.physicsItems = this.physicsItems.filter(b => !b.isDead);
      }

      // Draw Main Canvas with try-catch safeguard so loop never dies
      try {
        this.drawCanvas();
      } catch (err) {
        console.warn("Draw canvas warning:", err);
      }

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

    // 2. Draw Mirrored Person with Selfie Segmentation cut-out (or fallback to mirrored video)
    let drewCutout = false;

    if (
      this.latestSegmentationResults &&
      this.latestSegmentationResults.segmentationMask &&
      this.video &&
      this.video.readyState >= 2
    ) {
      try {
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

        const frameImg = this.latestSegmentationResults.image || this.video;

        // Draw mask & video mirrored onto offscreen canvas
        oCtx.save();
        oCtx.translate(width, 0);
        oCtx.scale(-1, 1);
        
        // Draw segmentation mask (white silhouette on transparent canvas)
        oCtx.drawImage(this.latestSegmentationResults.segmentationMask, 0, 0, width, height);
        
        // Crop video into silhouette
        oCtx.globalCompositeOperation = 'source-in';
        oCtx.drawImage(frameImg, 0, 0, width, height);
        oCtx.restore();

        // Draw the mirrored person cut-out onto main canvas over theme background!
        this.ctx.drawImage(this.offscreenCanvas, 0, 0, width, height);
        drewCutout = true;
      } catch (err) {
        console.warn("Segmentation cutout draw failed, using fallback:", err);
      }
    }

    if (!drewCutout && this.video && this.video.readyState >= 2) {
      // Safe Fallback: draw mirrored full video stream over theme background
      this.ctx.save();
      this.ctx.translate(width, 0);
      this.ctx.scale(-1, 1);
      this.ctx.drawImage(this.video, 0, 0, width, height);
      this.ctx.restore();
    }

    // 3. Draw 4-Player Pose Skeleton Landmarks & update physical hand/foot sensors
    this.drawPoseLandmarks(width, height);

    // 4. Draw Matter.js Physics Items
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
    const activeSensorKeys = new Set();

  drawPoseLandmarks(w, h) {
    const playerColors = ['#00f3ff', '#ff007f', '#00ff66', '#ffe600'];
    const activeSensorKeys = new Set();
    const Bodies = Matter.Bodies;
    const World = Matter.World;
    const scaleFactor = Math.max(0.65, Math.min(1.0, w / 1000));

    const renderSensorCircle = (key, lx, ly, r, color) => {
      activeSensorKeys.add(key);

      // Update or create Matter.js physical sensor body (strictly matched to visual circle radius r)
      let sensor = this.sensorPool[key];
      if (!sensor || sensor.targetRadius !== r) {
        if (sensor) {
          World.remove(this.physicsWorld, sensor);
        }
        sensor = Bodies.circle(lx, ly, r, {
          isStatic: true,
          isSensor: true,
          label: key
        });
        sensor.isPlayerSensor = true;
        sensor.targetRadius = r;
        this.sensorPool[key] = sensor;
        World.add(this.physicsWorld, sensor);
      } else {
        Matter.Body.setPosition(sensor, { x: lx, y: ly });
      }

      // Draw glowing circle around collision zone
      this.ctx.save();
      this.ctx.fillStyle = color;
      this.ctx.globalAlpha = 0.25;
      this.ctx.beginPath();
      this.ctx.arc(lx, ly, r, 0, Math.PI * 2);
      this.ctx.fill();

      // Neon glowing border
      this.ctx.globalAlpha = 1.0;
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 3;
      this.ctx.shadowColor = color;
      this.ctx.shadowBlur = 12;
      this.ctx.stroke();

      // Center white indicator point
      this.ctx.fillStyle = '#ffffff';
      this.ctx.shadowBlur = 0;
      this.ctx.beginPath();
      this.ctx.arc(lx, ly, 6, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    };

    // 1. Multi-Hand Tracking (detects hands for Player 1, Player 2, Player 3, Player 4!)
    let hasHands = false;
    if (this.latestHandsResults && this.latestHandsResults.multiHandLandmarks && this.latestHandsResults.multiHandLandmarks.length > 0) {
      hasHands = true;
      const hands = this.latestHandsResults.multiHandLandmarks;

      hands.forEach((handLm, idx) => {
        if (idx >= 8) return;
        const lm0 = handLm[0];
        const lm9 = handLm[9] || lm0;
        if (!lm0) return;

        // Palm center: midpoint of wrist and middle finger knuckle
        const hx = (lm0.x + lm9.x) / 2;
        const hy = (lm0.y + lm9.y) / 2;

        const lx = (1 - hx) * w;
        const ly = hy * h;
        const r = Math.round(42 * scaleFactor);

        // Assign player color based on screen horizontal position (Left side = P1 cyan, Right side = P2 pink)
        const playerIdx = lx < w * 0.5 ? 0 : 1;
        const color = playerColors[playerIdx];
        const key = `Hand_${idx}`;

        renderSensorCircle(key, lx, ly, r, color);
      });
    }

    // 2. Pose Tracking (Head, Feet, and fallback Hands if MediaPipe Hands is loading)
    if (this.latestPoseResults && this.latestPoseResults.poseLandmarks) {
      const lm = this.latestPoseResults.poseLandmarks;

      // Head (Face/Forehead)
      if (lm[0] && (lm[0].visibility === undefined || lm[0].visibility >= 0.05)) {
        const lx = (1 - lm[0].x) * w;
        const ly = Math.max(0, lm[0].y - 0.035) * h;
        const r = Math.round(46 * scaleFactor);
        renderSensorCircle('Pose_head', lx, ly, r, playerColors[0]);
      }

      // Left Foot (Ankle 27 & Toe 31)
      if (lm[27] && (lm[27].visibility === undefined || lm[27].visibility >= 0.05)) {
        const toe = lm[31] || lm[27];
        const lx = (1 - (lm[27].x + toe.x) / 2) * w;
        const ly = ((lm[27].y + toe.y) / 2) * h;
        const r = Math.round(42 * scaleFactor);
        renderSensorCircle('Pose_foot_l', lx, ly, r, playerColors[0]);
      }

      // Right Foot (Ankle 28 & Toe 32)
      if (lm[28] && (lm[28].visibility === undefined || lm[28].visibility >= 0.05)) {
        const toe = lm[32] || lm[28];
        const lx = (1 - (lm[28].x + toe.x) / 2) * w;
        const ly = ((lm[28].y + toe.y) / 2) * h;
        const r = Math.round(42 * scaleFactor);
        renderSensorCircle('Pose_foot_r', lx, ly, r, playerColors[0]);
      }

      // Fallback Hands from Pose if multi-hand model hasn't returned yet
      if (!hasHands) {
        if (lm[15] && (lm[15].visibility === undefined || lm[15].visibility >= 0.05)) {
          const indexLm = lm[19] || lm[15];
          const lx = (1 - (lm[15].x + indexLm.x) / 2) * w;
          const ly = ((lm[15].y + indexLm.y) / 2) * h;
          const r = Math.round(42 * scaleFactor);
          renderSensorCircle('Pose_hand_l', lx, ly, r, playerColors[0]);
        }
        if (lm[16] && (lm[16].visibility === undefined || lm[16].visibility >= 0.05)) {
          const indexLm = lm[20] || lm[16];
          const lx = (1 - (lm[16].x + indexLm.x) / 2) * w;
          const ly = ((lm[16].y + indexLm.y) / 2) * h;
          const r = Math.round(42 * scaleFactor);
          renderSensorCircle('Pose_hand_r', lx, ly, r, playerColors[0]);
        }
      }
    }

    // Hide any sensors that were not detected in this frame offscreen
    if (this.sensorPool) {
      Object.keys(this.sensorPool).forEach((key) => {
        if (!activeSensorKeys.has(key)) {
          Matter.Body.setPosition(this.sensorPool[key], { x: -9999, y: -9999 });
        }
      });
    }
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

    const btnToggleCam = document.getElementById('btn-toggle-cam');
    if (btnToggleCam) {
      btnToggleCam.addEventListener('click', () => this.toggleWebcam());
    }

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

    const btnStart = document.getElementById('btn-start');
    const btnStop = document.getElementById('btn-stop');
    btnStart.disabled = true;
    btnStop.disabled = false;

    audio.init();

    // 60s Countdown Timer
    this.timerInterval = setInterval(() => {
      this.timer--;
      document.getElementById('timer-display').textContent = this.timer;

      if (this.timer <= 0) {
        this.gameOver();
      }
    }, 1000);

    // Start periodic item spawner
    this.startItemSpawner();
  }

  stopGame() {
    this.isPlaying = false;
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.stopItemSpawner();

    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-stop').disabled = true;
  }

  resetGame() {
    this.stopGame();
    this.score = 0;
    this.timer = 60;
    document.getElementById('score-display').textContent = '0';
    document.getElementById('timer-display').textContent = '60';

    // Clear all items from physics world
    this.physicsItems.forEach(item => Matter.World.remove(this.physicsWorld, item));
    this.physicsItems = [];
    this.customPhoneItems = [];
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
          if (isScore) {
            this.currentScoreTexture = data.imageData;
            this.currentScoreShape = data.shape || 'circle';
          } else {
            this.currentObstacleTexture = data.imageData;
            this.currentObstacleShape = data.shape || 'circle';
          }

          // If game is actively playing, trigger an immediate drop with the new texture!
          if (this.isPlaying) {
            this.spawnRandomItem();
          }
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
    const fallbackMsg = document.getElementById('camera-fallback-msg');

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 640, height: 640 }, audio: false })
        .then((stream) => {
          video.srcObject = stream;
          if (fallbackMsg) fallbackMsg.style.display = 'none';
        })
        .catch(() => {
          // Fallback to user facing camera
          navigator.mediaDevices.getUserMedia({ video: true, audio: false })
            .then((stream) => {
              video.srcObject = stream;
              if (fallbackMsg) fallbackMsg.style.display = 'none';
            })
            .catch(() => {
              if (fallbackMsg) fallbackMsg.style.display = 'flex';
            });
        });
    } else {
      if (fallbackMsg) fallbackMsg.style.display = 'flex';
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

    // Live Camera Capture Photo Button
    document.getElementById('btn-capture').addEventListener('click', () => {
      const video = document.getElementById('mobile-video');
      if (video && video.readyState >= 2) {
        this.cropLoadedImage(video);
      } else {
        // If live camera is not ready, trigger file picker input
        const fileInput = document.getElementById('mobile-file-input');
        if (fileInput) fileInput.click();
      }
    });

    // File Upload Picker Event
    const fileInput = document.getElementById('mobile-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (evt) => {
            const img = new Image();
            img.onload = () => {
              this.cropLoadedImage(img);
            };
            img.src = evt.target.result;
          };
          reader.readAsDataURL(file);
          // Reset file input value so selecting the same photo triggers change event on iOS/Android
          e.target.value = '';
        }
      });
    }

    // Retake / Choose Again
    document.getElementById('btn-retake').addEventListener('click', () => {
      const btnGroup = document.getElementById('capture-btn-group');
      if (btnGroup) btnGroup.style.display = 'flex';
      document.getElementById('preview-actions').style.display = 'none';
      document.getElementById('preview-container').style.display = 'none';
    });

    // Send to PC Button
    document.getElementById('btn-send-item').addEventListener('click', () => {
      this.sendItemToPC();
    });
  }

  cropLoadedImage(source) {
    const canvas = document.getElementById('crop-canvas');
    const ctx = canvas.getContext('2d');

    const size = 300;
    canvas.width = size;
    canvas.height = size;

    ctx.clearRect(0, 0, size, size);

    // Get source width & height (video or image)
    const sw = source.videoWidth || source.width || 640;
    const sh = source.videoHeight || source.height || 640;

    const minDim = Math.min(sw, sh);
    const sx = (sw - minDim) / 2;
    const sy = (sh - minDim) / 2;

    ctx.drawImage(source, sx, sy, minDim, minDim, 0, 0, size, size);

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

    // Display Preview UI
    document.getElementById('preview-img').src = this.capturedImageData;
    const btnGroup = document.getElementById('capture-btn-group');
    if (btnGroup) btnGroup.style.display = 'none';

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

      this.conn.on('close', () => {
        statusEl.textContent = 'PC切断 (再読取必要)';
        statusEl.style.color = '#ff007f';
      });

      this.conn.on('error', () => {
        statusEl.textContent = '接続エラー';
        statusEl.style.color = '#ff007f';
      });
    });
  }

  sendItemToPC() {
    if (!this.capturedImageData) {
      alert('送信する画像を選択してください。');
      return;
    }

    if (!this.conn || !this.conn.open) {
      alert('PCとのP2P通信を接続中です...画面のQRコードをもう一度読み取るか、数秒待って再試行してください。');
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
    const btnGroup = document.getElementById('capture-btn-group');
    if (btnGroup) btnGroup.style.display = 'flex';
    document.getElementById('preview-actions').style.display = 'none';
    document.getElementById('preview-container').style.display = 'none';
  }
}

// Initialize Application when DOM ready
window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
