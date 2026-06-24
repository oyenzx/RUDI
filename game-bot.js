const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const config     = JSON.parse(fs.readFileSync(path.join(__dirname, 'wallet-config.json'), 'utf8'));
const botConfig  = JSON.parse(fs.readFileSync(path.join(__dirname, 'bot-config.json'),    'utf8'));

// Baca pilihan mode dari bot-config.json (Y = aktif, selain Y = skip)
const ENABLE_TREE   = (botConfig.modes.tebangKayu  || 'Y').toUpperCase() === 'Y';
const ENABLE_BATTLE = (botConfig.modes.pertarungan  || 'Y').toUpperCase() === 'Y';
const ENABLE_GOLD   = (botConfig.modes.tambangEmas  || 'Y').toUpperCase() === 'Y';

// Baca konfigurasi auto-skill
const ENABLE_SKILL  = (botConfig.autoSkill && botConfig.autoSkill.aktif || 'Y').toUpperCase() === 'Y';
const SKILL_PRIORITY = (botConfig.autoSkill && botConfig.autoSkill.prioritas) || ['vit', 'str', 'agi'];

// Bangun urutan mode berdasarkan pilihan pengguna: kayu → battle → gold
const MODES = [];
if (ENABLE_TREE)   MODES.push('tree');
if (ENABLE_BATTLE) MODES.push('battle');
if (ENABLE_GOLD)   MODES.push('gold');

if (MODES.length === 0) {
  console.error('[BOT] Semua mode dinonaktifkan di bot-config.json! Aktifkan minimal 1 mode.');
  process.exit(1);
}

// Jarak maksimal mengejar mob
const MAX_MOB_CHASE_DIST = 400;
// Koordinat tile ke world: tile * 64
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

    this.modeIdx   = 0;
    this.mode      = MODES[0]; 
    this.modeTimer = null;     

    this.currentMobId           = null;
    this.currentTargetTreeCoord = null; 
    this.isMoving                = false;

    this._gotLootThisMode = false;

    this.stateInterval  = null;
    this.attackInterval = null;

    this.sessionWood   = 0;
    this.sessionGold   = 0;
    this.sessionMeat   = 0;
    this.sessionKills  = 0;
    this.totalAttacks  = 0;
    this.totalSkillUps = 0;

    this.reconnectAttempts    = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay       = 3000;
    this._running              = false;
    this._pingTimer           = null;
    this._statsInterval      = null;
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  connect() {
    return new Promise((resolve, reject) => {
      console.log(`[BOT] Menghubungkan ke ${config.gameServer.url}`);
      this.ws = new WebSocket(config.gameServer.url);

      this.ws.on('open', () => {
        console.log('[BOT] Terhubung!');
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
        console.log(`[BOT] Koneksi terputus (code: ${code})`);
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
      console.error('[BOT] Gagal reconnect, menyerah.');
    }
  }

  stopIntervals() {
    if (this.stateInterval)  { clearInterval(this.stateInterval);  this.stateInterval  = null; }
    if (this.attackInterval) { clearInterval(this.attackInterval); this.attackInterval = null; }
  }

  disconnect() {
    this._running = false;
    this.stopIntervals();
    if (this._statsInterval) { clearInterval(this._statsInterval); this._statsInterval = null; }
    if (this.ws) { this.ws.close(); this.isConnected = false; }
  }

  // ─── Kirim Pesan ───────────────────────────────────────────────────────────

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

  // ─── Auto Skill Allocation ─────────────────────────────────────────────────

  allocateSkill(stat) {
    this.send({ t: 'allocate', stat: stat });
    this.totalSkillUps++;
    const names = { vit: 'Vitality', str: 'Strength', agi: 'Agility' };
    console.log(`[BOT] 🎯 Skill UP: ${names[stat] || stat} (total upgrade: ${this.totalSkillUps})`);
  }

  checkAndAllocateSkills() {
    if (!ENABLE_SKILL) return;
    if (this.xp.free <= 0) return;

    for (const stat of SKILL_PRIORITY) {
      if (this.xp.free > 0) {
        this.allocateSkill(stat);
        this.xp.free--;
        break; 
      }
    }
  }

  // ─── Terima Pesan ──────────────────────────────────────────────────────────

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.t) {
      case 'welcome':
        this.player.id       = msg.id;
        this.isAuthenticated = true;
        console.log(`[BOT] Autentikasi berhasil! ID: ${msg.id}`);
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
        const prevLv   = this.xp.level;
        const prevFree = this.xp.free;
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
          console.log(`[BOT] ⬆️  NAIK LEVEL! Sekarang level ${msg.level} | Free points: ${msg.free}`);
        }
        if (msg.free > 0 && msg.free !== prevFree) {
          console.log(`[BOT] 💡 Free skill points: ${msg.free} | STR:${msg.str} VIT:${msg.vit} AGI:${msg.agi}`);
          setTimeout(() => this.checkAndAllocateSkills(), 500);
        }
        break;
      }

      case 'stats': {
        const prevKills = this.stats.mobKills;
        this.stats = { mobKills: msg.mobKills || 0, pvpWins: msg.pvpWins || 0 };
        if (msg.mobKills > prevKills) {
          this.sessionKills += (msg.mobKills - prevKills);
          console.log(`[BOT] 💀 Mob mati! Total kills: ${this.stats.mobKills}`);
          if (this.mode === 'battle' && !this._gotLootThisMode) {
            this._gotLootThisMode = true;
            this.advanceMode();
          }
        }
        break;
      }

      case 'loot':
        this.onLoot(msg.item, msg.qty);
        break;

      case 'world':
        this.updateWorld(msg);
        break;

      default:
        break;
    }
  }

  onLoot(item, qty) {
    switch (item) {
      case 'wood':
        this.sessionWood += qty;
        console.log(`[BOT] 🌲 Kayu +${qty} (sesi: +${this.sessionWood}) | Inv: ${this.inventory.wood}`);
        break;
      case 'gold':
        this.sessionGold += qty;
        console.log(`[BOT] ⛏️  Emas +${qty} (sesi: +${this.sessionGold}) | Inv: ${this.inventory.gold}`);
        if (this.mode === 'gold' && !this._gotLootThisMode) {
          this._gotLootThisMode = true;
          this.advanceMode();
        }
        break;
      case 'meat':
        this.sessionMeat += qty;
        console.log(`[BOT] 🥩 Daging +${qty} (sesi: +${this.sessionMeat}) | Inv: ${this.inventory.meat}`);
        if (this.mode === 'battle' && !this._gotLootThisMode) {
          this._gotLootThisMode = true;
          this.advanceMode();
        }
        break;
      default:
        console.log(`[BOT] 🎁 Loot: ${item} x${qty}`);
        if (!this._gotLootThisMode) {
          this._gotLootThisMode = true;
          this.advanceMode();
        }
    }
  }

  updateWorld(msg) {
    if (msg.mobs)     this.world.mobs     = msg.mobs;
    if (msg.trees)    this.world.trees    = msg.trees;
    if (msg.golds)    this.world.golds    = msg.golds;
    if (msg.players)  this.world.players  = msg.players;
    if (msg.treeHits) this.world.treeHits = msg.treeHits;

    // ULTRA SINKRONISASI: Begitu server mengirim data world baru, paksa bot mengevaluasi posisi pohon saat ini juga
    if (this.isConnected && this.isAuthenticated && this.mode === 'tree') {
      this.doTree();
    }
  }

  // ─── Logic Utama ───────────────────────────────────────────────────────────

  startIntervals() {
    // TWEAK 1: Percepat kirim posisi koordinat ke server menjadi 40ms agar sinkronisasi perpindahan real-time tanpa delay langkah
    this.stateInterval  = setInterval(() => this.sendState(), 40);
    
    // TWEAK 2: Percepat eksekusi pemukulan & pergerakan dasar ke 100ms (Sangat Responsif!)
    this.attackInterval = setInterval(() => this.attackTick(), 100);

    this.startCurrentMode();
  }

  startCurrentMode() {
    this._gotLootThisMode = false;
    this.currentMobId           = null;
    this.currentTargetTreeCoord = null; 
    this.isMoving                = false;

    console.log(`\n[BOT] 🔄 Mode: ${this.getModeLabel(this.mode)} — memanen otomatis secara ULTRA CEPAT...\n`);
  }

  advanceMode() {
    this.modeIdx = (this.modeIdx + 1) % MODES.length;
    this.mode    = MODES[this.modeIdx];
    this.startCurrentMode();
  }

  getModeLabel(mode) {
    const labels = { battle: '⚔️  PERTARUNGAN', tree: '🌲 TEBANG POHON', gold: '⛏️  TAMBANG EMAS' };
    return labels[mode] || mode;
  }

  attackTick() {
    if (!this.isConnected || !this.isAuthenticated) return;

    switch (this.mode) {
      case 'battle': this.doBattle(); break;
      case 'tree':   this.doTree();   break;
      case 'gold':   this.doGold();   break;
    }
  }

  doBattle() {
    const aliveMobs = this.world.mobs.filter(m =>
      m.state !== 'dead' &&
      m.hpPct >= 1.0 &&
      this.distanceTo(m.x, m.y) <= MAX_MOB_CHASE_DIST
    );

    if (this.currentMobId) {
      const mob = this.world.mobs.find(m =>
        m.id === this.currentMobId &&
        m.state !== 'dead' &&
        m.hpPct > 0
      );
      if (!mob) {
        this.currentMobId = null;
      } else {
        const dist = this.distanceTo(mob.x, mob.y);
        if (dist > 120) {
          this.moveToward(mob.x, mob.y, 120);
        } else {
          this.isMoving = false;
          this.sendAttack();
        }
        return;
      }
    }

    if (aliveMobs.length > 0) {
      const nearest = aliveMobs.reduce((best, mob) =>
        this.distanceTo(mob.x, mob.y) < this.distanceTo(best.x, best.y) ? mob : best
      , aliveMobs[0]);
      this.currentMobId = nearest.id;
      console.log(`[BOT] 🎯 Target mob HP 100%: ${nearest.type} jarak:${this.distanceTo(nearest.x, nearest.y).toFixed(0)}`);
    } else {
      if (Math.random() < 0.3) this.randomWander(150);
    }
  }

  // ULTRA OPTIMIZED TREE MODE (ANTI DELAY / INSTANT CHASE)
  doTree() {
    const availableTrees = this.world.trees.filter(t => t.hpPct === undefined || t.hpPct > 0);

    if (availableTrees.length > 0) {
      let targetTree = null;

      const parseTreeWorld = (t) => {
        const wx = t.x !== undefined ? (t.x > 1000 ? t.x : t.x * TILE_TO_WORLD) : (t.wx || 0);
        const wy = t.y !== undefined ? (t.y > 1000 ? t.y : t.y * TILE_TO_WORLD) : (t.wy || 0);
        return { wx, wy, coordKey: `${wx}_${wy}`, hpPct: t.hpPct };
      };

      if (this.currentTargetTreeCoord) {
        const mappedTrees = availableTrees.map(t => parseTreeWorld(t));
        targetTree = mappedTrees.find(t => t.coordKey === this.currentTargetTreeCoord);
      }

      // TWEAK 3: Jika target pohon tidak valid atau sudah ditebang, ganti kunci target secara instan saat itu juga
      if (!targetTree) {
        const treesWorld = availableTrees.map(t => parseTreeWorld(t));
        const nearest = treesWorld.reduce((best, t) =>
          this.distanceTo(t.wx, t.wy) < this.distanceTo(best.wx, best.wy) ? t : best
        , treesWorld[0]);

        this.currentTargetTreeCoord = nearest.coordKey;
        targetTree = nearest;
        console.log(`[BOT] 🎯 Mengunci pohon baru di posisi: (${targetTree.wx}, ${targetTree.wy}) | Jarak: ${this.distanceTo(targetTree.wx, targetTree.wy).toFixed(0)}`);
      }

      const dist = this.distanceTo(targetTree.wx, targetTree.wy);

      if (dist > 55) {
        // TWEAK 4: Jika jarak sangat jauh (seperti di log Anda jarak 1726), bot diizinkan melangkah lompat jauh sebesar 250 unit per langkah agar instan sampai!
        const currentStep = dist > 500 ? 250 : 150;
        this.moveToward(targetTree.wx, targetTree.wy, currentStep);
      } else {
        this.isMoving = false;
        this.sendAttack();
      }
    } else {
      this.currentTargetTreeCoord = null;
      if (Math.random() < 0.1) this.randomWander(150);
    }
  }

  doGold() {
    const fullDeposits = this.world.golds.filter(g => g.pct === 0);
    const available    = fullDeposits.length > 0
      ? fullDeposits
      : this.world.golds.filter(g => g.pct < 1.0);

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

      if (dist > 80) {
        this.moveToward(nearest.wx, nearest.wy, 150);
      } else {
        this.isMoving = false;
        this.sendAttack();
      }
    } else {
      this.sendAttack();
      if (Math.random() < 0.1) this.randomWander(200);
    }
  }

  // ─── Helper ────────────────────────────────────────────────────────────────

  moveToward(tx, ty, step = 150) {
    const dx   = tx - this.player.x;
    const dy   = ty - this.player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 10) return;
    this.player.x      = Math.round(this.player.x + (dx / dist) * step);
    this.player.y      = Math.round(this.player.y + (dy / dist) * step);
    this.player.facing = dx > 0 ? 1 : -1;
    this.player.bd     = dx > 0 ? 'right' : 'left';
    this.isMoving      = true;
  }

  randomWander(radius = 200) {
    const angle   = Math.random() * Math.PI * 2;
    this.player.x = Math.round(this.player.x + Math.cos(angle) * radius);
    this.player.y = Math.round(this.player.y + Math.sin(angle) * radius);
    this.isMoving = true;
    setTimeout(() => { this.isMoving = false; }, 200); // Dipersingkat ke 200ms agar durasi bengong sangat minim
  }

  distanceTo(x, y) {
    const dx = x - this.player.x;
    const dy = y - this.player.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  startAutoPlay() {
    this._running = true;
    console.log('[BOT] Auto-play dimulai (MODE ULTRA SAT-SET SELESAI DIKODE, Ctrl+C untuk berhenti)');
    return new Promise(() => {});
  }

  printStats() {
    const mobs      = this.world.mobs.filter(m => m.state !== 'dead').length;
    const mobsFull  = this.world.mobs.filter(m => m.state !== 'dead' && m.hpPct >= 1.0).length;
    const goldAvail = this.world.golds.filter(g => g.pct < 1).length;
    const goldFull  = this.world.golds.filter(g => g.pct === 0).length;
    const treeFull  = this.world.trees.filter(t => t.hpPct === undefined || t.hpPct >= 1.0).length;
    console.log('\n─────────────── STATISTIK ───────────────');
    console.log(`Mode aktif : ${this.getModeLabel(this.mode)}`);
    console.log(`Level      : ${this.xp.level} | XP: ${this.xp.xp} (${this.xp.cur}/${this.xp.next})`);
    console.log(`Skills     : STR=${this.xp.str} VIT=${this.xp.vit} AGI=${this.xp.agi} | Free=${this.xp.free} | Speed=${this.xp.speedMult}x`);
    console.log(`Inventory  : 🌲 Kayu=${this.inventory.wood}  ⛏️  Emas=${this.inventory.gold}  🥩 Daging=${this.inventory.meat}`);
    console.log(`Sesi ini   : +${this.sessionWood} kayu | +${this.sessionGold} emas | +${this.sessionMeat} daging | ${this.sessionKills} kill | ${this.totalSkillUps} skill up`);
    console.log(`Serangan   : ${this.totalAttacks} | Posisi: (${this.player.x}, ${this.player.y})`);
    console.log(`Dunia      : ${mobs} mob (${mobsFull} HP100%) | ${this.world.trees.length} pohon (${treeFull} HP100%) | ${goldFull} deposit emas HP100% / ${goldAvail} tersedia`);
    console.log('─────────────────────────────────────────\n');
  }

  getGameState() {
    return {
      mode:      this.mode,
      player:    this.player,
      inventory: this.inventory,
      xp:        this.xp,
      stats:     this.stats,
      world: {
        mobs:  this.world.mobs.length,
        trees: this.world.trees.length,
        golds: this.world.golds.length
      }
    };
  }
}

module.exports = GameBot;

if (require.main === module) {
  const bot = new GameBot();

  process.on('SIGINT', () => {
    console.log('\n[BOT] Menghentikan bot...');
    bot.printStats(); 
    bot.disconnect();
    process.exit(0);
  });

  bot.connect()
    .then(() => bot.startAutoPlay())
    .catch(err => {
      console.error('[BOT] Error fatal:', err.message);
      process.exit(1);
    });
}