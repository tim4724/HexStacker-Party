'use strict';

const {
  LINE_CLEAR_SCORES, TSPIN_SCORES, TSPIN_MINI_SCORES,
  COMBO_TABLE, BACK_TO_BACK_MULTIPLIER
} = require('./constants');

class Scoring {
  constructor() {
    this.score = 0;
    this.level = 1;
    this.lines = 0;
    this.combo = -1;
    this.backToBack = false;
  }

  addLineClear(linesCleared, isTSpin, isTSpinMini) {
    if (linesCleared === 0 && !isTSpin && !isTSpinMini) return null;

    this.combo++;

    const isTetris = linesCleared === 4;
    const isDifficult = isTetris || isTSpin;

    // Base score
    let points = 0;
    if (isTSpinMini) {
      points = TSPIN_MINI_SCORES[linesCleared] || 0;
    } else if (isTSpin) {
      points = TSPIN_SCORES[linesCleared] || 0;
    } else {
      points = LINE_CLEAR_SCORES[linesCleared] || 0;
    }

    // Level multiplier
    points *= this.level;

    // Back-to-back bonus
    if (isDifficult) {
      if (this.backToBack) {
        points = Math.floor(points * BACK_TO_BACK_MULTIPLIER);
      }
      this.backToBack = true;
    } else if (linesCleared > 0) {
      this.backToBack = false;
    }

    // Combo bonus
    const comboIndex = Math.min(this.combo, COMBO_TABLE.length - 1);
    const comboBonus = COMBO_TABLE[comboIndex] * this.level;
    points += comboBonus;

    this.score += points;
    this.lines += linesCleared;
    this.level = Math.floor(this.lines / 10) + 1;

    return {
      score: points,
      linesAdded: linesCleared,
      combo: this.combo,
      backToBack: this.backToBack,
      isTetris,
      isTSpin
    };
  }

  resetCombo() {
    this.combo = -1;
  }

  addSoftDrop(cells) {
    this.score += cells;
  }

  addHardDrop(cells) {
    this.score += cells * 2;
  }

  getLevel() {
    this.level = Math.floor(this.lines / 10) + 1;
    return this.level;
  }

  getState() {
    return {
      score: this.score,
      level: this.level,
      lines: this.lines,
      combo: this.combo,
      backToBack: this.backToBack
    };
  }
}

module.exports = { Scoring };
