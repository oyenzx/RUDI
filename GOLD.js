const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const config     = JSON.parse(fs.readFileSync(path.join(__dirname, 'wallet-config.json'), 'utf8'));
const botConfig  = JSON.parse(fs.readFileSync(path.join(__dirname, 'bot-config.json'),    'utf8'));

const ENABLE_SKILL   = (botConfig.autoSkill && botConfig.autoSkill.aktif || 'Y').toUpperCase() === 'Y';
const SKILL_PRIORITY = ['str', 'agi', 'vit']; 

const TILE_TO_WORLD = 64;

class GameBot {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.isAuthenticated = false;

    this.player = {
      id: null,
      x: 16000,
      y: 16000,
      facing: 1,
      boat: false,
      bd: 'right',
      vcx: 16000,
      vcy: 16000,
      vr: 3275
    };

    this.inventory = { wood: 0, gold: 0, meat: 0, usdc: 0 };
    this.stats     = { mobKills: 0, pvpWins: 0 };
    this.xp        = { level: 1, xp: 0, cur: 0, next: 100, str: 0, vit: 0, agi: 0, free: 0, speedMult: 1 };
    this.world     = { trees: [], golds: [], mobs: [], players: [], treeHits: [] };

    this.mode      = 'gold'; 
    this.isMoving  = false;

    this.stateInterval  = null;
    this.attackInterval = null;
    this.backupInterval = null;
    this.skillInterval  = null; // Jalur mandiri khusus alokasi stat

    this.sessionGold   = 0;
    this.totalAttacks  = 0;
    this.totalSkillUps = 0;

    this.reconnectAttempts    = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay       = 3000;
    this._running              = false;
    this._pingTimer           = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      console.log(`[BOT] Menghubungkan ke ${config.gameServer.url}`);
      this.ws = new WebSocket(config.gameServer.url);

      this.ws.on('open', () => {
        console.log('[BOT] Terhubung dengan Sukses!');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.sendHello();
        this._pingTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 15000);
        resolve();
      });

      this.ws.on('pong', () => {});
      this.ws.on('message', (data) => this.handleMessage(data));

      this.ws.on('error', (err) => {
        console.error('[BOT] Error:', err.message);
        this.isConnected = false;
        if (!this.isAuthenticated) reject(err);
      });

      this.ws.on('close', (code) => {
        console.log(`[BOT] Koneksi terputus (code: ${code}). Mengaktifkan auto-reconnect...`);
        this.isConnected     = false;
        this.isAuthenticated = false;
        if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
        this.stopIntervals();
        if (this._running) this.attemptReconnect();
      });

      setTimeout(() => {
        if (!this.isConnected) reject(new Error('Timeout koneksi'));
      }, 10000);
    });
  }

  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`[BOT] Mencoba reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      setTimeout(() => {
        this.connect()
          .then(() => {})
          .catch(e => console.error('[BOT] Reconnect gagal:', e.message));
      }, this.reconnectDelay);
    } else {
      console.error('[BOT] Gagal reconnect, sistem mati.');
    }
  }

  stopIntervals() {
    if (this.stateInterval)  { clearInterval(this.stateInterval);  this.stateInterval  = null; }
    if (this.attackInterval) { clearInterval(this.attackInterval); this.attackInterval = null; }
    if (this.backupInterval) { clearInterval(this.backupInterval); this.backupInterval = null; }
    if (this.skillInterval)  { clearInterval(this.skillInterval);  this.skillInterval  = null; }
  }

  disconnect() {
    this._running = false;
    this.stopIntervals();
    if (this.ws) { this.ws.close(); this.isConnected = false; }
  }

  send(msg) {
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendHello() {
    this.send({
      t: 'hello',
      auth: {
        walletAddress: config.auth.walletAddress,
        sessionToken:  config.auth.sessionToken
      },
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
      vcx:    this.player.vcx,
      vcy:    this.player.vcy,
      vr:     this.player.vr
    });
    this.player.vcx = Math.round(this.player.vcx * 0.9 + this.player.x * 0.1);
    this.player.vcy = Math.round(this.player.vcy * 0.9 + this.player.y * 0.1);
  }

  sendAttack() {
    this.send({ t: 'attack' });
    this.totalAttacks++;
  }

  allocateSkill(stat) {
    this.send({ t: 'allocate', stat: stat });
    this.totalSkillUps++;
    const names = { vit: 'Vitality', str: 'Strength', agi: 'Agility' };
    console.log(`[BOT] 🎯 Skill UP Sukses: ${names[stat] || stat} (Total: ${this.totalSkillUps})`);
  }

  // SOLUSI TOTAL ANTI-STUCK: Alokasi poin ditarik keluar jalur utama ke thread interval independen
  processSkillPoints() {
    if (!ENABLE_SKILL || this.xp.free <= 0 || !this.isConnected || !this.isAuthenticated) return;

    for (const stat of SKILL_PRIORITY) {
      this.allocateSkill(stat);
      this.xp.free--; 
      break; 
    }
  }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.t) {
      case 'welcome':
        this.player.id       = msg.id;
        this.isAuthenticated = true;
        console.log(`[BOT] Autentikasi Berhasil! ID: ${msg.id}`);
        this.startIntervals();
        break;

      case 'inv':
        this.inventory = {
          wood: msg.wood || 0,
          gold: msg.gold || 0,
          meat: msg.meat || 0,
          usdc: msg.usdc || 0
        };
        break;

      case 'xp': {
        const prevLv = this.xp.level;
        this.xp = {
          level:     msg.level,
          xp:        msg.xp,
          cur:       msg.cur,
          next:      msg.next,
          str:       msg.str  || 0,
          vit:       msg.vit  || 0,
          agi:       msg.agi  || 0,
          free:      msg.free || 0,
          speedMult: msg.speedMult || 1
        };
        if (msg.level > prevLv) {
          console.log(`[BOT] ⬆️ NAIK LEVEL! Sekarang Level ${msg.level}.`);
        }
        break;
      }

      case 'loot':
        if (msg.item === 'gold') {
          this.sessionGold += msg.qty;
          console.log(`[BOT] ⛏️ GOLD: +${msg.qty} (Total Sesi: +${this.sessionGold}) | Inv: ${this.inventory.gold}`);
        }
        break;

      case 'world':
        this.world.golds = msg.golds || this.world.golds;
        this.world.players = msg.players || this.world.players;
        break;
    }
  }

  startIntervals() {
    // 1. Pengiriman paket posisi (35ms)
    this.stateInterval  = setInterval(() => this.sendState(), 35);
    
    // 2. Engine Pencarian & Pemukulan Emas (85ms)
    this.attackInterval = setInterval(() => this.doGold(), 85);
    
    // 3. Engine Konsumsi Skill Poin Mandiri (200ms) - Menguras poin secara berkala tanpa menyumbat WebSocket
    this.skillInterval  = setInterval(() => this.processSkillPoints(), 200);
    
    // 4. Sistem Pemulihan Koordinat Darurat (2,5 Detik)
    this.backupInterval = setInterval(() => {
      if (this.isConnected && this.isAuthenticated && !this.isMoving && this.world.golds.length === 0) {
        this.randomWander(200);
      }
    }, 2500);

    console.log(`\n[BOT] 🔄 MODE HYPER GOLD AKTIF! Menambang 24/7 Tanpa Jeda...\n`);
  }

  doGold() {
    if (!this.isConnected || !this.isAuthenticated) return;

    const fullDeposits = this.world.golds.filter(g => g.pct === 0);
    const available    = fullDeposits.length > 0 ? fullDeposits : this.world.golds.filter(g => g.pct < 1.0);

    if (available.length > 0) {
      const goldsWorld = available.map(g => ({
        wx: g.x * TILE_TO_WORLD,
        wy: g.y * TILE_TO_WORLD,
        pct: g.pct
      }));

      const nearest = goldsWorld.reduce((best, g) =>
        this.distanceTo(g.wx, g.wy) < this.distanceTo(best.wx, best.wy) ? g : best
      , goldsWorld[0]);

      const dist = this.distanceTo(nearest.wx, nearest.wy);

      if (dist > 85) {
        const safeStep = dist > 400 ? 150 : 100; 
        this.moveToward(nearest.wx, nearest.wy, safeStep);
      } else {
        this.isMoving = false;
        this.sendAttack();
      }
    } else {
      this.sendAttack();
      if (Math.random() < 0.15) this.randomWander(250);
    }
  }

  moveToward(tx, ty, step = 130) {
    const dx   = tx - this.player.x;
    const dy   = ty - this.player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 5) return;
    
    this.player.x      = Math.round(this.player.x + (dx / dist) * step);
    this.player.y      = Math.round(this.player.y + (dy / dist) * step);
    this.player.facing = dx > 0 ? 1 : -1;
    this.player.bd     = dx > 0 ? 'right' : 'left';
    this.isMoving      = true;
  }

  randomWander(radius = 250) {
    const angle   = Math.random() * Math.PI * 2;
    this.player.x = Math.round(this.player.x + Math.cos(angle) * radius);
    this.player.y = Math.round(this.player.y + Math.sin(angle) * radius);
    this.isMoving = true;
    setTimeout(() => { this.isMoving = false; }, 80);
  }

  distanceTo(x, y) {
    const dx = x - this.player.x;
    const dy = y - this.player.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  startAutoPlay() {
    this._running = true;
    return new Promise(() => {});
  }
}

if (require.main === module) {
  const bot = new GameBot();

  process.on('SIGINT', () => {
    console.log('\n[BOT] Mematikan sistem...');
    bot.disconnect();
    process.exit(0);
  });

  bot.connect()
    .then(() => bot.startAutoPlay())
    .catch(err => {
      console.error('[BOT] Fatal Error:', err.message);
      process.exit(1);
    });
}