#!/usr/bin/env node

const GameBot = require('./game-bot');
const fs = require('fs');
const path = require('path');

/**
 * Bot Verification Script - Test all bot functionality
 */

class BotVerifier {
  constructor() {
    this.bot = null;
    this.testResults = {
      connectionTest: false,
      authTest: false,
      gameStateTest: false,
      actionTests: {
        cutTree: false,
        mineGold: false,
        startBattle: false,
        attack: false,
        defend: false
      },
      autoPlayTest: false
    };
  }

  /**
   * Run all verification tests
   */
  async runAllTests() {
    console.log('========== BOT VERIFICATION SUITE ==========\n');

    try {
      await this.testConnection();
      await this.testAuthentication();
      await this.testGameState();
      await this.testActions();
      await this.testAutoPlay();
      
      this.printResults();
    } catch (error) {
      console.error('[VERIFIER] Fatal error during testing:', error.message);
    } finally {
      if (this.bot) {
        this.bot.disconnect();
      }
    }
  }

  /**
   * Test WebSocket connection
   */
  async testConnection() {
    console.log('[TEST] Testing WebSocket connection...');
    try {
      this.bot = new GameBot();
      await this.bot.connect();
      this.testResults.connectionTest = true;
      console.log('[PASS] WebSocket connection successful\n');
    } catch (error) {
      console.error('[FAIL] WebSocket connection failed:', error.message, '\n');
    }
  }

  /**
   * Test authentication
   */
  async testAuthentication() {
    console.log('[TEST] Testing authentication...');
    if (!this.bot || !this.bot.isConnected) {
      console.error('[FAIL] Bot not connected\n');
      return;
    }

    try {
      // Wait for auth response
      await this.sleep(2000);
      this.testResults.authTest = true;
      console.log('[PASS] Authentication successful\n');
    } catch (error) {
      console.error('[FAIL] Authentication failed:', error.message, '\n');
    }
  }

  /**
   * Test game state retrieval
   */
  async testGameState() {
    console.log('[TEST] Testing game state retrieval...');
    if (!this.bot || !this.bot.isConnected) {
      console.error('[FAIL] Bot not connected\n');
      return;
    }

    try {
      this.bot.requestGameState();
      await this.sleep(1000);
      
      const state = this.bot.getGameState();
      if (state && Object.keys(state).length > 0) {
        this.testResults.gameStateTest = true;
        console.log('[PASS] Game state retrieved:', state, '\n');
      } else {
        console.error('[FAIL] Game state is empty\n');
      }
    } catch (error) {
      console.error('[FAIL] Game state retrieval failed:', error.message, '\n');
    }
  }

  /**
   * Test all game actions
   */
  async testActions() {
    console.log('[TEST] Testing game actions...');
    if (!this.bot || !this.bot.isConnected) {
      console.error('[FAIL] Bot not connected\n');
      return;
    }

    try {
      // Test cut trees
      console.log('  - Testing cut trees action...');
      this.bot.cutTrees();
      await this.sleep(500);
      this.testResults.actionTests.cutTree = true;
      console.log('    [PASS] Cut trees action sent');

      // Test mine gold
      console.log('  - Testing mine gold action...');
      this.bot.mineGold();
      await this.sleep(500);
      this.testResults.actionTests.mineGold = true;
      console.log('    [PASS] Mine gold action sent');

      // Test start battle
      console.log('  - Testing start battle action...');
      this.bot.startBattle('test_enemy');
      await this.sleep(500);
      this.testResults.actionTests.startBattle = true;
      console.log('    [PASS] Start battle action sent');

      // Test attack
      console.log('  - Testing attack action...');
      this.bot.attack();
      await this.sleep(500);
      this.testResults.actionTests.attack = true;
      console.log('    [PASS] Attack action sent');

      // Test defend
      console.log('  - Testing defend action...');
      this.bot.defend();
      await this.sleep(500);
      this.testResults.actionTests.defend = true;
      console.log('    [PASS] Defend action sent\n');

    } catch (error) {
      console.error('[FAIL] Action test failed:', error.message, '\n');
    }
  }

  /**
   * Test auto-play functionality
   */
  async testAutoPlay() {
    console.log('[TEST] Testing auto-play functionality...');
    if (!this.bot || !this.bot.isConnected) {
      console.error('[FAIL] Bot not connected\n');
      return;
    }

    try {
      console.log('  - Running auto-play for 10 seconds...');
      await this.bot.autoPlay(10000);
      this.testResults.autoPlayTest = true;
      console.log('[PASS] Auto-play test completed\n');
    } catch (error) {
      console.error('[FAIL] Auto-play test failed:', error.message, '\n');
    }
  }

  /**
   * Print test results
   */
  printResults() {
    console.log('========== TEST RESULTS ==========\n');

    const results = this.testResults;
    let passCount = 0;
    let totalTests = 0;

    // Connection test
    totalTests++;
    if (results.connectionTest) {
      console.log('✓ Connection Test: PASS');
      passCount++;
    } else {
      console.log('✗ Connection Test: FAIL');
    }

    // Authentication test
    totalTests++;
    if (results.authTest) {
      console.log('✓ Authentication Test: PASS');
      passCount++;
    } else {
      console.log('✗ Authentication Test: FAIL');
    }

    // Game state test
    totalTests++;
    if (results.gameStateTest) {
      console.log('✓ Game State Test: PASS');
      passCount++;
    } else {
      console.log('✗ Game State Test: FAIL');
    }

    // Action tests
    console.log('\nAction Tests:');
    for (const [action, passed] of Object.entries(results.actionTests)) {
      totalTests++;
      if (passed) {
        console.log(`  ✓ ${action}: PASS`);
        passCount++;
      } else {
        console.log(`  ✗ ${action}: FAIL`);
      }
    }

    // Auto-play test
    totalTests++;
    if (results.autoPlayTest) {
      console.log('\n✓ Auto-Play Test: PASS');
      passCount++;
    } else {
      console.log('\n✗ Auto-Play Test: FAIL');
    }

    console.log(`\n========== SUMMARY ==========`);
    console.log(`Total Tests: ${totalTests}`);
    console.log(`Passed: ${passCount}`);
    console.log(`Failed: ${totalTests - passCount}`);
    console.log(`Success Rate: ${((passCount / totalTests) * 100).toFixed(2)}%`);
    console.log(`=============================\n`);

    process.exit(passCount === totalTests ? 0 : 1);
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main execution
if (require.main === module) {
  const verifier = new BotVerifier();
  verifier.runAllTests();
}

module.exports = BotVerifier;
