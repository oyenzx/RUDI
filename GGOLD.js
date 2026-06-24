const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const config     = JSON.parse(fs.readFileSync(path.join(__dirname, 'wallet-config.json'), 'utf8'));
const botConfig  = JSON.parse(fs.readFileSync(path.join(__dirname, 'bot-config.json'),    'utf8'));

const ENABLE_SKILL  = (botConfig.autoSkill && botConfig.autoSkill.aktif || 'Y').toUpperCase() === 'Y';
const SKILL_PRIORITY = (botConfig.autoSkill && botConfig.autoSkill.prioritas) || ['str', 'vit', 'agi']; 

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

    this.inventory = { gold: 0 };
    this.xp        = { level: 1, free: 0, speedMult: 1 };
    this.world     = { golds: [] }; 

    this.currentTargetGoldCoord = null; 
    this.isMoving                = false;

    // State radar scanning
    this.searchAngle = 0;
    this.searchRadius = 250; 

    this.stateInterval  = null;
    this.attackInterval = null;

    this.sessionGold   = 0; 
    this.totalAttacks  = 0;
    this.totalSkillUps = 0;

    this._running = false;
    this._pingTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      console.log(`[BOT] Menghubungkan ke ${config.gameServer.url}`);
      this.ws = new WebSocket(config.gameServer.url);

      this.ws.on('open', () => {
        console.log('[BOT] Terhubung ke Islands server!');
        this.isConnected = true;
        this.sendHello();
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
        if (this._running) setTimeout(() => this.connect(), 3000);
      });
    });
  }

  stopIntervals() {
    if (this.stateInterval) clearInterval(this.stateInterval);
    if (this.attackInterval) clearInterval(this.attackInterval);
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
      vcx:    this.player.x, 
      vcy:    this.player.y,
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
        console.log(`[BOT] Login Sukses! Menjalankan Engine Tambang Emas Hyper Sat-Set.`);
        this.startIntervals();
        break;
      case 'inv':
        this.inventory = { gold: msg.gold || 0 };
        break;
      case 'xp':
        const prevLv = this.xp.level;
        this.xp = { level: msg.level, free: msg.free || 0, speedMult: msg.speedMult || 1 };
        if (msg.level > prevLv) console.log(`[BOT] ⬆️ LEVEL UP! Sekarang Level ${msg.level}`);
        if (msg.free > 0) this.checkAndAllocateSkills();
        break;
      case 'nodeLocked':
        if (msg.kind === 'gold') {
          console.log(`[BOT] 🔒 Gagal Tambang! Batuan Emas butuh Level ${msg.need}. Level Anda saat ini: Lv${this.xp.level}`);
        }
        break;
      case 'loot':
        if (msg.item === 'gold') {
          this.sessionGold += msg.qty;
          console.log(`[BOT] ⛏️ +${msg.qty} Emas Dipahat! (Total Sesi: ${this.sessionGold})`);
          this.searchRadius = 250; 
        }
        break;
      case 'world':
        if (msg.golds) this.world.golds = msg.golds; 
        break;
    }
  }

  startIntervals() {
    this.stateInterval  = setInterval(() => this.sendState(), 40);
    this.attackInterval = setInterval(() => this.processRadarFarming(), 60);
  }

  processRadarFarming() {
    if (!this.isConnected || !this.isAuthenticated) return;

    const availableGolds = (this.world.golds || []).filter(g => g.hpPct === undefined || g.hpPct > 0);

    if (availableGolds.length > 0) {
      let targetGold = null;

      const parseGoldWorld = (g) => {
        const wx = g.x !== undefined ? (g.x > 1000 ? g.x : g.x * TILE_TO_WORLD) : (g.wx || 0);
        const wy = g.y !== undefined ? (g.y > 1000 ? g.y : g.y * TILE_TO_WORLD) : (g.wy || 0);
        return { wx, wy, coordKey: `${wx}_${wy}`, hpPct: g.hpPct };
      };

      if (this.currentTargetGoldCoord) {
        const mappedGolds = availableGolds.map(g => parseGoldWorld(g));
        targetGold = mappedGolds.find(g => g.coordKey === this.currentTargetGoldCoord && (g.hpPct === undefined || g.hpPct > 0));
      }

      if (!targetGold) {
        const goldsWorld = availableGolds.map(g => parseGoldWorld(g));
        const nearest = goldsWorld.reduce((best, g) =>
          this.distanceTo(g.wx, g.wy) < this.distanceTo(best.wx, best.wy) ? g : best
        , goldsWorld[0]);

        this.currentTargetGoldCoord = nearest.coordKey;
        targetGold = nearest;
        console.log(`[BOT] 🎯 Kunci Batu Emas -> Jarak: ${this.distanceTo(targetGold.wx, targetGold.wy).toFixed(0)} unit. INSTANT DASH!`);
      }

      const dist = this.distanceTo(targetGold.wx, targetGold.wy);

      if (dist > 52) {
        let hyperStep = 85;
        if (dist > 400) {
          hyperStep = 500;
        } else if (dist > 150) {
          hyperStep = 250;
        }

        const finalStep = Math.min(dist, hyperStep * this.xp.speedMult);
        this.moveToward(targetGold.wx, targetGold.wy, finalStep);
      } else {
        this.isMoving = false;
        this.sendAttack();
        this.sendAttack(); 
      }
    } else {
      this.currentTargetGoldCoord = null;
      this.radarSweep();
    }
  }

  moveToward(tx, ty, step) {
    const dx   = tx - this.player.x;
    const dy   = ty - this.player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return;

    this.player.x      = Math.round(this.player.x + (dx / dist) * step);
    this.player.y      = Math.round(this.player.y + (dy / dist) * step);
    this.player.facing = dx > 0 ? 1 : -1;
    this.player.bd      = dx > 0 ? 'right' : 'left';
    this.isMoving      = true;
  }

  radarSweep() {
    this.searchAngle += 0.4;
    this.searchRadius += 8;  

    if (this.searchRadius > 800) this.searchRadius = 200;

    const targetX = Math.round(this.player.x + Math.cos(this.searchAngle) * this.searchRadius);
    const targetY = Math.round(this.player.y + Math.sin(this.searchAngle) * this.searchRadius);
    
    console.log(`[BOT] 🔍 Scan Area Tambang... Radius: ${this.searchRadius} unit`);
    this.moveToward(targetX, targetY, 140); 
  }

  distanceTo(x, y) {
    const dx = x - this.player.x;
    const dy = y - this.player.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  startAutoPlay() {
    this._running = true;
    console.log('[BOT] ⛏️ MODE HYPER-GOLD MINING SAT-SET RUNNING!');
    return new Promise(() => {});
  }
}

module.exports = GameBot;

if (require.main === module) {
  const bot = new GameBot();
  process.on('SIGINT', () => { process.exit(0); });
  bot.connect().then(() => bot.startAutoPlay()).catch(() => process.exit(1));
}