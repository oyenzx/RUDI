const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Fungsi pembantu untuk membaca JSON dengan aman agar tidak langsung crash jika format salah
function loadJsonConfig(fileName) {
  try {
    const filePath = path.join(__dirname, fileName);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`[ERROR] Gagal membaca atau parse file ${fileName}:`, error.message);
    process.exit(1);
  }
}

const config    = loadJsonConfig('wallet-config.json');
const botConfig = loadJsonConfig('bot-config.json');

// Prioritas stat untuk bertarung
const ENABLE_SKILL   = (botConfig.autoSkill && botConfig.autoSkill.aktif || 'Y').toUpperCase() === 'Y';
const SKILL_PRIORITY = (botConfig.autoSkill && botConfig.autoSkill.prioritas) || ['str', 'agi', 'vit'];

const TILE_TO_WORLD = 64;

class GameBot {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.isAuthenticated = false;

    this.player = {
      id: null, x: 16000, y: 16000, facing: 1, boat: false,
      bd: 'right', vcx: 16000, vcy: 16000, vr: 3275
    };

    this.inventory = { wood: 0 };
    this.xp        = { level: 1, free: 0, speedMult: 1 };
    this.world     = { mobs: [] }; // Menampung data Monster

    this.currentTargetMobId = null; 
    this.isMoving           = false;

    // State radar scanning
    this.searchAngle = 0;
    this.searchRadius = 250; 

    this.stateInterval  = null;
    this.attackInterval = null;

    this.sessionKills  = 0;
    this.totalAttacks  = 0;
    this.totalSkillUps = 0;

    this._running = false;
    this._pingTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const options = {};
      
      // Menggunakan proxy jika dikonfigurasi di wallet-config.json
      if (config.proxy) {
        console.log(`[BOT] Menggunakan Proxy: ${config.proxy}`);
        options.agent = new HttpsProxyAgent(config.proxy);
      }

      console.log(`[BOT] Menghubungkan ke ${config.gameServer.url}`);
      this.ws = new WebSocket(config.gameServer.url, options);

      this.ws.on('open', () => {
        console.log('[BOT] Terhubung ke Islands server!');
        this.isConnected = true;
        this.sendHello();
        
        if (this._pingTimer) clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
        }, 15000);
        resolve();
      });

      this.ws.on('pong', () => {});
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('error', (err) => { this.isConnected = false; reject(err); });
      this.ws.on('close', () => {
        this.isConnected = false;
        this.stopIntervals();
        if (this._running) {
          console.log('[BOT] Koneksi terputus. Mencoba menghubungkan kembali dalam 3 detik...');
          setTimeout(() => this.connect().catch(() => {}), 3000);
        }
      });
    });
  }

  stopIntervals() {
    if (this.stateInterval) clearInterval(this.stateInterval);
    if (this.attackInterval) clearInterval(this.attackInterval);
    if (this._pingTimer) clearInterval(this._pingTimer);
  }

  send(msg) {
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendHello() {
    this.send({
      t: 'hello',
      auth: { walletAddress: config.auth.walletAddress, sessionToken: config.auth.sessionToken },
      name:  config.player.name,
      color: config.player.color
    });
  }

  sendState() {
    this.send({
      t:      'state',
      x:      this.player.x,
      y:      this.player.y,
      moving: this.isMoving,
      facing: this.player.facing,
      boat:   this.player.boat,
      bd:     this.player.bd,
      vcx:    this.player.vcx, // Ter-sinkronisasi dari moveToward
      vcy:    this.player.vcy, // Ter-sinkronisasi dari moveToward
      vr:     this.player.vr
    });
  }

  sendAttack() {
    this.send({ t: 'attack' });
    this.totalAttacks++;
  }

  checkAndAllocateSkills() {
    if (!ENABLE_SKILL || this.xp.free <= 0) return;
    for (const stat of SKILL_PRIORITY) {
      if (this.xp.free > 0) {
        this.send({ t: 'allocate', stat: stat });
        this.totalSkillUps++;
        this.xp.free--;
        break; 
      }
    }
  }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.t) {
      case 'welcome':
        this.player.id = msg.id;
        this.isAuthenticated = true;
        console.log(`[BOT] Login Sukses! Menjalankan Engine PVP/PVE Murder-Mode.`);
        this.startIntervals();
        break;
      case 'inv':
        if (msg.wood !== undefined) this.inventory.wood = msg.wood;
        break;
      case 'xp':
        const prevLv = this.xp.level;
        this.xp = { level: msg.level, free: msg.free || 0, speedMult: msg.speedMult || 1 };
        if (msg.level > prevLv) console.log(`[BOT] ⬆️ LEVEL UP! Sekarang Level ${msg.level}`);
        if (msg.free > 0) this.checkAndAllocateSkills();
        break;
      case 'loot':
        console.log(`[BOT] ⚔️ Loot terjatuh: ${msg.item} x${msg.qty}`);
        break;
      case 'world':
        if (msg.mobs) {
          this.world.mobs = msg.mobs;
        }
        break;
      case 'death':
        if (msg.id === this.currentTargetMobId) {
          this.sessionKills++;
          console.log(`[BOT] 💀 Target Mati! Total Kill Sesi Ini: ${this.sessionKills}`);
          this.currentTargetMobId = null;
          this.searchRadius = 250;
        }
        break;
    }
  }

  startIntervals() {
    // Memberikan sedikit variasi jeda acak (jitter) agar antar akun tidak berbenturan paket di ms yang sama
    const jitter = Math.floor(Math.random() * 15);
    this.stateInterval  = setInterval(() => this.sendState(), 45 + jitter);
    this.attackInterval = setInterval(() => this.processRadarCombat(), 65 + jitter);
  }

  // ─── ENGINE COMBAT RADAR & MONSTER HUNTING ───────────────────
  processRadarCombat() {
    if (!this.isConnected || !this.isAuthenticated) return;

    const availableMobs = (this.world.mobs || []).filter(m => m.hp === undefined || m.hp > 0);

    if (availableMobs.length > 0) {
      let targetMob = null;

      const mappedMobs = availableMobs.map(m => {
        const wx = m.x !== undefined ? (m.x > 1000 ? m.x : m.x * TILE_TO_WORLD) : (m.wx || 0);
        const wy = m.y !== undefined ? (m.y > 1000 ? m.y : m.y * TILE_TO_WORLD) : (m.wy || 0);
        return { id: m.id, type: m.type || 'Monster', wx, wy, hp: m.hp };
      });

      if (this.currentTargetMobId) {
        targetMob = mappedMobs.find(m => m.id === this.currentTargetMobId);
      }

      // Pencarian monster terdekat yang dioptimasi tanpa beban reduce berlebih
      if (!targetMob) {
        let minDistance = Infinity;
        for (const m of mappedMobs) {
          const d = this.distanceTo(m.wx, m.wy);
          if (d < minDistance) {
            minDistance = d;
            targetMob = m;
          }
        }

        if (targetMob) {
          this.currentTargetMobId = targetMob.id;
          console.log(`[BOT] ⚔️ LOCK TARGET -> [${targetMob.type}] Jarak: ${minDistance.toFixed(0)} unit. INSTANT DASH COMBO!`);
        }
      }

      if (targetMob) {
        const dist = this.distanceTo(targetMob.wx, targetMob.wy);

        if (dist > 48) {
          let hyperStep = 90;
          if (dist > 400) {
            hyperStep = 550;
          } else if (dist > 150) {
            hyperStep = 300;
          }

          const finalStep = Math.min(dist, hyperStep * this.xp.speedMult);
          this.moveToward(targetMob.wx, targetMob.wy, finalStep);
        } else {
          this.isMoving = false;
          // BURST COMBAT: Spam 3x serangan instan per tick
          this.sendAttack();
          this.sendAttack();
          this.sendAttack();
        }
      }
    } else {
      this.currentTargetMobId = null;
      this.radarSweep();
    }
  }

  moveToward(tx, ty, step) {
    const dx   = tx - this.player.x;
    const dy   = ty - this.player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return;

    const nextX = Math.round(this.player.x + (dx / dist) * step);
    const nextY = Math.round(this.player.y + (dy / dist) * step);

    this.player.x      = nextX;
    this.player.y      = nextY;
    this.player.vcx    = nextX; // vcx sinkron dengan posisi real x
    this.player.vcy    = nextY; // vcy sinkron dengan posisi real y
    this.player.facing = dx > 0 ? 1 : -1;
    this.player.bd     = dx > 0 ? 'right' : 'left';
    this.isMoving      = true;
  }

  radarSweep() {
    this.searchAngle += 0.5;
    this.searchRadius += 12;  

    if (this.searchRadius > 1000) this.searchRadius = 200;

    const targetX = Math.round(this.player.x + Math.cos(this.searchAngle) * this.searchRadius);
    const targetY = Math.round(this.player.y + Math.sin(this.searchAngle) * this.searchRadius);
    
    console.log(`[BOT] 🔍 Mencari Tanda Kehidupan Monster... Radius: ${this.searchRadius} unit`);
    this.moveToward(targetX, targetY, 150); 
  }

  distanceTo(x, y) {
    const dx = x - this.player.x;
    const dy = y - this.player.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  startAutoPlay() {
    this._running = true;
    console.log('[BOT] ⚔️ MODE PERTARUNGAN AGRESIF (MURDER-MODE) DIALIRKAN!');
    return new Promise(() => {});
  }
}

module.exports = GameBot;

if (require.main === module) {
  const bot = new GameBot();
  process.on('SIGINT', () => { 
    bot.stopIntervals();
    process.exit(0); 
  });
  bot.connect().then(() => bot.startAutoPlay()).catch(() => process.exit(1));
}
