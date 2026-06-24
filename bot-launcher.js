#!/usr/bin/env node

const GameBot = require('./game-bot');
const fs = require('fs');
const path = require('path');

const config    = JSON.parse(fs.readFileSync(path.join(__dirname, 'wallet-config.json'), 'utf8'));
const botConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'bot-config.json'),    'utf8'));

const ENABLE_TREE   = (botConfig.modes.tebangKayu  || 'Y').toUpperCase() === 'Y';
const ENABLE_BATTLE = (botConfig.modes.pertarungan  || 'Y').toUpperCase() === 'Y';
const ENABLE_GOLD   = (botConfig.modes.tambangEmas  || 'Y').toUpperCase() === 'Y';
const ENABLE_SKILL  = (botConfig.autoSkill && botConfig.autoSkill.aktif || 'Y').toUpperCase() === 'Y';
const SKILL_PRIO    = (botConfig.autoSkill && botConfig.autoSkill.prioritas) || ['vit', 'str', 'agi'];

const skillNames = { vit: 'Vitality', str: 'Strength', agi: 'Agility' };

console.log('════════════════════════════════════════');
console.log('      ISLANDS.GAMES AUTO-BOT v4.1       ');
console.log('════════════════════════════════════════');
console.log(`Player  : ${config.player.name}`);
console.log(`Wallet  : ${config.auth.walletAddress.slice(0, 12)}...`);
console.log(`Server  : ${config.gameServer.url}`);
console.log('────────────────────────────────────────');
console.log('Konfigurasi Mode (dari bot-config.json):');
console.log(`  🌲 Tebang Pohon (HP 100%) : ${ENABLE_TREE   ? '✅ AKTIF' : '❌ NONAKTIF'}`);
console.log(`  ⚔️  Pertarungan (HP 100%)  : ${ENABLE_BATTLE ? '✅ AKTIF' : '❌ NONAKTIF'}`);
console.log(`  ⛏️  Tambang Emas (HP 100%) : ${ENABLE_GOLD   ? '✅ AKTIF' : '❌ NONAKTIF'}`);
console.log('────────────────────────────────────────');
console.log(`Auto Skill Upgrade         : ${ENABLE_SKILL ? '✅ AKTIF' : '❌ NONAKTIF'}`);
if (ENABLE_SKILL) {
  const prioStr = SKILL_PRIO.map((s, i) => `${i+1}. ${skillNames[s] || s}`).join(' → ');
  console.log(`  Prioritas: ${prioStr}`);
  console.log('  (Skill di-upgrade otomatis saat naik level / ada free point)');
}
console.log('────────────────────────────────────────');
console.log('Sistem: Mode berganti hanya setelah dapat loot 1x');
console.log('        Tidak ada batas waktu — bot menunggu sampai berhasil');
console.log('────────────────────────────────────────');
console.log('Edit bot-config.json untuk mengubah pengaturan');
console.log('Tekan Ctrl+C untuk berhenti');
console.log('════════════════════════════════════════\n');

const bot = new GameBot();

process.on('SIGINT', () => {
  console.log('\n[LAUNCHER] Menghentikan bot...');
  bot.printStats();
  bot.disconnect();
  process.exit(0);
});

bot.connect()
  .then(() => bot.startAutoPlay())
  .catch(err => {
    console.error('[LAUNCHER] Error:', err.message);
    process.exit(1);
  });
