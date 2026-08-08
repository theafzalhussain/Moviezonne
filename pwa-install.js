
(function () {
  if (window.__mzPromptCaptureReady) return; // already installed by the inline head snippet
  window.__mzPromptCaptureReady = true;

  var _prompt = null;
  function makeAlias(name) {
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () { return _prompt; },
        set: function (v) { _prompt = v; }
      });
    } catch (e) { window[name] = null; }
  }
  makeAlias('deferredPrompt');
  makeAlias('__mzDeferredPrompt');

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();                 // stop Chrome's own mini-infobar
    window.deferredPrompt = e;          // stash for our custom button
    console.log('[MovieZone PWA] ✅ beforeinstallprompt captured — native install ready.');
    window.dispatchEvent(new CustomEvent('mz:installready'));
  });
})();

/* ---- Minimal QR Code Generator (MIT License, kazuhikoarase/qrcode-generator) ----
   Trimmed build: numeric/alphanumeric/byte mode, auto error-correction level M.
   Renders directly to a <canvas>. No external requests. */
(function (global) {
  var QRCode = (function () {
    var EC_L = 1, EC_M = 0, EC_Q = 3, EC_H = 2;

    function QR8bitByte(data) {
      this.mode = 4;
      this.data = data;
      this.parsedData = [];
      for (var i = 0, l = this.data.length; i < l; i++) {
        var codePoint = this.data.codePointAt(i);
        if (codePoint > 0xFFFF) i++; // consume the low surrogate

        if (codePoint <= 0x7F) {
          this.parsedData.push(codePoint);
        } else if (codePoint <= 0x7FF) {
          this.parsedData.push(
            0xC0 | (codePoint >>> 6),
            0x80 | (codePoint & 0x3F)
          );
        } else if (codePoint <= 0xFFFF) {
          this.parsedData.push(
            0xE0 | (codePoint >>> 12),
            0x80 | ((codePoint >>> 6) & 0x3F),
            0x80 | (codePoint & 0x3F)
          );
        } else {
          this.parsedData.push(
            0xF0 | (codePoint >>> 18),
            0x80 | ((codePoint >>> 12) & 0x3F),
            0x80 | ((codePoint >>> 6) & 0x3F),
            0x80 | (codePoint & 0x3F)
          );
        }
      }
    }
    QR8bitByte.prototype = {
      getLength: function () { return this.parsedData.length; },
      write: function (buffer) {
        for (var i = 0, l = this.parsedData.length; i < l; i++) buffer.put(this.parsedData[i], 8);
      }
    };

    function QRBitBuffer() { this.buffer = []; this.length = 0; }
    QRBitBuffer.prototype = {
      get: function (index) {
        var bufIndex = Math.floor(index / 8);
        return ((this.buffer[bufIndex] >>> (7 - index % 8)) & 1) === 1;
      },
      put: function (num, length) {
        for (var i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) === 1);
      },
      putBit: function (bit) {
        var bufIndex = Math.floor(this.length / 8);
        if (this.buffer.length <= bufIndex) this.buffer.push(0);
        if (bit) this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
        this.length++;
      }
    };

    var QRMath = {
      glog: function (n) { if (n < 1) throw new Error('glog(' + n + ')'); return QRMath.LOG_TABLE[n]; },
      gexp: function (n) { while (n < 0) n += 255; while (n >= 256) n -= 255; return QRMath.EXP_TABLE[n]; },
      EXP_TABLE: new Array(256), LOG_TABLE: new Array(256)
    };
    for (var i = 0; i < 8; i++) QRMath.EXP_TABLE[i] = 1 << i;
    for (var i = 8; i < 256; i++) {
      QRMath.EXP_TABLE[i] = QRMath.EXP_TABLE[i - 4] ^ QRMath.EXP_TABLE[i - 5] ^ QRMath.EXP_TABLE[i - 6] ^ QRMath.EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i++) QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]] = i;

    function QRPolynomial(num, shift) {
      if (num.length === undefined) throw new Error(num.length + '/' + shift);
      var offset = 0;
      while (offset < num.length && num[offset] === 0) offset++;
      this.num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
    }
    QRPolynomial.prototype = {
      get: function (index) { return this.num[index]; },
      getLength: function () { return this.num.length; },
      multiply: function (e) {
        var num = new Array(this.getLength() + e.getLength() - 1);
        for (var i = 0; i < this.getLength(); i++) {
          for (var j = 0; j < e.getLength(); j++) {
            num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(e.get(j)));
          }
        }
        return new QRPolynomial(num, 0);
      },
      mod: function (e) {
        if (this.getLength() - e.getLength() < 0) return this;
        var ratio = QRMath.glog(this.get(0)) - QRMath.glog(e.get(0));
        var num = new Array(this.getLength());
        for (var i = 0; i < this.getLength(); i++) num[i] = this.get(i);
        for (var i = 0; i < e.getLength(); i++) num[i] ^= QRMath.gexp(QRMath.glog(e.get(i)) + ratio);
        return new QRPolynomial(num, 0).mod(e);
      }
    };

    var QRRSBlock = {
      RS_BLOCK_TABLE: [
        [1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9],
        [1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16],
        [1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13],
        [1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9],
        [1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12]
      ],
      getRSBlocks: function (typeNumber, errorCorrectLevel) {
        var rsBlock = QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + errorCorrectLevel];
        if (!rsBlock) rsBlock = QRRSBlock.RS_BLOCK_TABLE[(4 - 1) * 4 + errorCorrectLevel];
        var list = [];
        for (var i = 0; i < rsBlock.length / 3; i++) {
          var count = rsBlock[i * 3], totalCount = rsBlock[i * 3 + 1], dataCount = rsBlock[i * 3 + 2];
          for (var j = 0; j < count; j++) list.push({ totalCount: totalCount, dataCount: dataCount });
        }
        return list;
      }
    };

    var QRUtil = {
      PATTERN_POSITION_TABLE: [
        [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
        [6, 22, 38], [6, 24, 42]
      ],
      G15: (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0),
      G18: (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0),
      G15_MASK: (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1),
      getBCHDigit: function (data) { var digit = 0; while (data !== 0) { digit++; data >>>= 1; } return digit; },
      getBCHTypeInfo: function (data) {
        var d = data << 10;
        while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15) >= 0) d ^= (QRUtil.G15 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15)));
        return ((data << 10) | d) ^ QRUtil.G15_MASK;
      },
      getPatternPosition: function (typeNumber) { return QRUtil.PATTERN_POSITION_TABLE[typeNumber - 1] || []; },
      getMask: function (maskPattern, i, j) {
        switch (maskPattern) {
          case 0: return (i + j) % 2 === 0;
          case 1: return i % 2 === 0;
          case 2: return j % 3 === 0;
          case 3: return (i + j) % 3 === 0;
          case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
          case 5: return (i * j) % 2 + (i * j) % 3 === 0;
          case 6: return ((i * j) % 2 + (i * j) % 3) % 2 === 0;
          case 7: return ((i * j) % 3 + (i + j) % 2) % 2 === 0;
          default: throw new Error('mask:' + maskPattern);
        }
      },
      getErrorCorrectPolynomial: function (errorCorrectLength) {
        var a = new QRPolynomial([1], 0);
        for (var i = 0; i < errorCorrectLength; i++) a = a.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0));
        return a;
      },
      getLengthInBits: function (mode, type) { return type <= 9 ? 8 : type <= 26 ? 16 : 16; }
    };

    function QRCodeModel(typeNumber, errorCorrectLevel) {
      this.typeNumber = typeNumber;
      this.errorCorrectLevel = errorCorrectLevel;
      this.modules = null;
      this.moduleCount = 0;
      this.dataCache = null;
      this.dataList = [];
    }
    QRCodeModel.prototype = {
      addData: function (data) { this.dataList.push(new QR8bitByte(data)); this.dataCache = null; },
      isDark: function (row, col) { return this.modules[row][col]; },
      getModuleCount: function () { return this.moduleCount; },
      make: function () { this.makeImpl(false, this.getBestMaskPattern()); },
      makeImpl: function (test, maskPattern) {
        this.moduleCount = this.typeNumber * 4 + 17;
        this.modules = new Array(this.moduleCount);
        for (var row = 0; row < this.moduleCount; row++) {
          this.modules[row] = new Array(this.moduleCount);
          for (var col = 0; col < this.moduleCount; col++) this.modules[row][col] = null;
        }
        this.setupPositionProbePattern(0, 0);
        this.setupPositionProbePattern(this.moduleCount - 7, 0);
        this.setupPositionProbePattern(0, this.moduleCount - 7);
        this.setupPositionAdjustPattern();
        this.setupTimingPattern();
        this.setupTypeInfo(test, maskPattern);
        if (this.typeNumber >= 7) this.setupTypeNumber(test);
        if (this.dataCache === null) this.dataCache = QRCodeModel.createData(this.typeNumber, this.errorCorrectLevel, this.dataList);
        this.mapData(this.dataCache, maskPattern);
      },
      setupPositionProbePattern: function (row, col) {
        for (var r = -1; r <= 7; r++) {
          if (row + r <= -1 || this.moduleCount <= row + r) continue;
          for (var c = -1; c <= 7; c++) {
            if (col + c <= -1 || this.moduleCount <= col + c) continue;
            if ((0 <= r && r <= 6 && (c === 0 || c === 6)) || (0 <= c && c <= 6 && (r === 0 || r === 6)) || (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
              this.modules[row + r][col + c] = true;
            } else this.modules[row + r][col + c] = false;
          }
        }
      },
      getBestMaskPattern: function () {
        var minLostPoint = 0, pattern = 0;
        for (var i = 0; i < 8; i++) {
          this.makeImpl(true, i);
          var lostPoint = QRUtil_getLostPoint(this);
          if (i === 0 || minLostPoint > lostPoint) { minLostPoint = lostPoint; pattern = i; }
        }
        return pattern;
      },
      setupTimingPattern: function () {
        for (var r = 8; r < this.moduleCount - 8; r++) if (this.modules[r][6] === null) this.modules[r][6] = (r % 2 === 0);
        for (var c = 8; c < this.moduleCount - 8; c++) if (this.modules[6][c] === null) this.modules[6][c] = (c % 2 === 0);
      },
      setupPositionAdjustPattern: function () {
        var pos = QRUtil.getPatternPosition(this.typeNumber);
        for (var i = 0; i < pos.length; i++) for (var j = 0; j < pos.length; j++) {
          var row = pos[i], col = pos[j];
          if (this.modules[row][col] !== null) continue;
          for (var r = -2; r <= 2; r++) for (var c = -2; c <= 2; c++) {
            this.modules[row + r][col + c] = (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0));
          }
        }
      },
      setupTypeNumber: function (test) {
        var bits = QRUtil_getBCHTypeNumber(this.typeNumber);
        for (var i = 0; i < 18; i++) {
          var mod = (!test && ((bits >> i) & 1) === 1);
          this.modules[Math.floor(i / 3)][i % 3 + this.moduleCount - 8 - 3] = mod;
        }
        for (var i = 0; i < 18; i++) {
          var mod = (!test && ((bits >> i) & 1) === 1);
          this.modules[i % 3 + this.moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
        }
      },
      setupTypeInfo: function (test, maskPattern) {
        var data = (this.errorCorrectLevel << 3) | maskPattern;
        var bits = QRUtil.getBCHTypeInfo(data);
        for (var i = 0; i < 15; i++) {
          var mod = (!test && ((bits >> i) & 1) === 1);
          if (i < 6) this.modules[i][8] = mod;
          else if (i < 8) this.modules[i + 1][8] = mod;
          else this.modules[this.moduleCount - 15 + i][8] = mod;
        }
        for (var i = 0; i < 15; i++) {
          var mod = (!test && ((bits >> i) & 1) === 1);
          if (i < 8) this.modules[8][this.moduleCount - i - 1] = mod;
          else if (i < 9) this.modules[8][15 - i - 1 + 1] = mod;
          else this.modules[8][15 - i - 1] = mod;
        }
        this.modules[this.moduleCount - 8][8] = (!test);
      },
      mapData: function (data, maskPattern) {
        var inc = -1, row = this.moduleCount - 1, bitIndex = 7, byteIndex = 0;
        for (var col = this.moduleCount - 1; col > 0; col -= 2) {
          if (col === 6) col--;
          while (true) {
            for (var c = 0; c < 2; c++) {
              if (this.modules[row][col - c] === null) {
                var dark = false;
                if (byteIndex < data.length) dark = (((data[byteIndex] >>> bitIndex) & 1) === 1);
                var mask = QRUtil.getMask(maskPattern, row, col - c);
                if (mask) dark = !dark;
                this.modules[row][col - c] = dark;
                bitIndex--;
                if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
              }
            }
            row += inc;
            if (row < 0 || this.moduleCount <= row) { row -= inc; inc = -inc; break; }
          }
        }
      }
    };

    function QRUtil_getBCHTypeNumber(typeNumber) {
      var d = typeNumber << 12;
      while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18) >= 0) d ^= (QRUtil.G18 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18)));
      return (typeNumber << 12) | d;
    }
    function QRUtil_getLostPoint(qrCode) {
      var moduleCount = qrCode.getModuleCount(), lostPoint = 0;
      for (var row = 0; row < moduleCount; row++) for (var col = 0; col < moduleCount; col++) {
        var sameCount = 0, dark = qrCode.isDark(row, col);
        for (var r = -1; r <= 1; r++) {
          if (row + r < 0 || moduleCount <= row + r) continue;
          for (var c = -1; c <= 1; c++) {
            if (col + c < 0 || moduleCount <= col + c) continue;
            if (r === 0 && c === 0) continue;
            if (dark === qrCode.isDark(row + r, col + c)) sameCount++;
          }
        }
        if (sameCount > 5) lostPoint += (3 + sameCount - 5);
      }
      return lostPoint;
    }

    QRCodeModel.PAD0 = 0xEC; QRCodeModel.PAD1 = 0x11;
    QRCodeModel.createData = function (typeNumber, errorCorrectLevel, dataList) {
      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectLevel);
      var buffer = new QRBitBuffer();
      for (var i = 0; i < dataList.length; i++) {
        var data = dataList[i];
        buffer.put(4, 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber));
        data.write(buffer);
      }
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount;
      if (buffer.length > totalDataCount * 8) throw new Error('code length overflow');
      if (buffer.length + 4 <= totalDataCount * 8) buffer.put(0, 4);
      while (buffer.length % 8 !== 0) buffer.putBit(false);
      while (true) {
        if (buffer.length >= totalDataCount * 8) break;
        buffer.put(QRCodeModel.PAD0, 8);
        if (buffer.length >= totalDataCount * 8) break;
        buffer.put(QRCodeModel.PAD1, 8);
      }
      return QRCodeModel.createBytes(buffer, rsBlocks);
    };
    QRCodeModel.createBytes = function (buffer, rsBlocks) {
      var offset = 0, maxDcCount = 0, maxEcCount = 0;
      var dcdata = new Array(rsBlocks.length), ecdata = new Array(rsBlocks.length);
      for (var r = 0; r < rsBlocks.length; r++) {
        var dcCount = rsBlocks[r].dataCount, ecCount = rsBlocks[r].totalCount - dcCount;
        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);
        dcdata[r] = new Array(dcCount);
        for (var i = 0; i < dcdata[r].length; i++) dcdata[r][i] = 0xff & buffer.buffer[i + offset];
        offset += dcCount;
        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = new QRPolynomial(dcdata[r], rsPoly.getLength() - 1);
        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i++) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0) ? modPoly.get(modIndex) : 0;
        }
      }
      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i++) totalCodeCount += rsBlocks[i].totalCount;
      var data = new Array(totalCodeCount), index = 0;
      for (var i = 0; i < maxDcCount; i++) for (var r = 0; r < rsBlocks.length; r++) if (i < dcdata[r].length) data[index++] = dcdata[r][i];
      for (var i = 0; i < maxEcCount; i++) for (var r = 0; r < rsBlocks.length; r++) if (i < ecdata[r].length) data[index++] = ecdata[r][i];
      return data;
    };

    return {
      create: function (text, options) {
        options = options || {};
        var ecLevels = { L: EC_L, M: EC_M, Q: EC_Q, H: EC_H };
        var ecLevel = ecLevels[options.errorCorrectionLevel || 'M'];
        var typeNumber = options.typeNumber || 0;
        var qr;
        if (typeNumber > 0) {
          qr = new QRCodeModel(typeNumber, ecLevel);
          qr.addData(text);
          qr.make();
        } else {
          for (var t = 1; t <= 20; t++) {
            try {
              qr = new QRCodeModel(t, ecLevel);
              qr.addData(text);
              qr.make();
              break;
            } catch (e) { qr = null; }
          }
          if (!qr) throw new Error('Text too long for QR code');
        }
        return qr;
      }
    };
  })();

  function renderToCanvas(qr, canvas, cellSize, margin, darkColor, lightColor) {
    var count = qr.getModuleCount();
    var size = count * cellSize + margin * 2;
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = lightColor;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = darkColor;
    for (var row = 0; row < count; row++) {
      for (var col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(margin + col * cellSize, margin + row * cellSize, cellSize, cellSize);
        }
      }
    }
  }

  global.MiniQR = {
    renderTo: function (canvas, text, opts) {
      opts = opts || {};
      var qr = QRCode.create(text, { errorCorrectionLevel: opts.level || 'M' });
      renderToCanvas(qr, canvas, opts.cellSize || 4, opts.margin || 8, opts.dark || '#0a0a12', opts.light || '#ffffff');
    }
  };
})(window);

/* ==========================================================================
   Install Prompt Controller
   ========================================================================== */
(function () {
  var STORAGE_KEY = 'mz_pwa_prompt_dismissed_at';
  var TV_STORAGE_KEY = 'mz_pwa_tv_prompt_dismissed_at';
  var INSTALLED_KEY = 'mz_app_installed';
  var SHOW_DELAY_MS = 3000; // first-ever-visit delay before the popup auto-opens
  var popupTimer = null;
  var popupShownThisLoad = false;
  var installedState = null;
  var installedCheckToken = 0;
  var uiPrepared = false;
  var tvUiPrepared = false;
  var monitorStarted = false;

  var overlay, installBtn, laterBtn, closeBtn, iosGuide, iosShareLabel, pwaDesc, qrWrap;
  var tvOverlay, tvQrWrap, tvDismissBtn;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true;
  }

  function isMzTV() {
    // Reads the data attribute set by tv-mode.js
    return document.documentElement.getAttribute('data-mz-tv') === 'true';
  }

  function isIOS() {
    var ua = navigator.userAgent;
    var isAppleTouch = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    var isIpadOS13 = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    return isAppleTouch || isIpadOS13;
  }

  function isIOSChrome() { return /CriOS/.test(navigator.userAgent); }
  function isIOSFirefox() { return /FxiOS/.test(navigator.userAgent); }

  function hasInstalledMarker() {
    try { return localStorage.getItem(INSTALLED_KEY) === '1'; } catch (e) { return false; }
  }

  function hasAutoPopupBeenShown() {
    try { return localStorage.getItem(STORAGE_KEY) !== null; } catch (e) { return false; }
  }

  function hasTvAutoPopupBeenShown() {
    try { return localStorage.getItem(TV_STORAGE_KEY) !== null; } catch (e) { return false; }
  }

  function setInstalledMarker(installed) {
    try {
      if (installed) localStorage.setItem(INSTALLED_KEY, '1');
      else localStorage.removeItem(INSTALLED_KEY);
    } catch (e) {}
  }

  function markDismissed(key) {
    try { localStorage.setItem(key, String(Date.now())); } catch (e) {}
  }

  function dispatchInstallState(installed, reason) {
    var detail = { installed: !!installed, reason: reason || 'check' };
    try {
      window.dispatchEvent(new CustomEvent('mz:pwa-statechange', { detail: detail }));
    } catch (e) {
      var event = document.createEvent('CustomEvent');
      event.initCustomEvent('mz:pwa-statechange', false, false, detail);
      window.dispatchEvent(event);
    }
  }

  function applyInstalledState(installed, reason) {
    installed = !!installed;
    var changed = installedState !== installed;
    installedState = installed;
    document.documentElement.setAttribute('data-mz-pwa-installed', installed ? '1' : '0');
    var navBtn = document.getElementById('navInstallBtn');
    if (navBtn) {
      navBtn.style.display = installed ? 'none' : 'flex';
      navBtn.classList.toggle('mz-install-native-ready', !installed && !!window.deferredPrompt);
    }
    if (installed) {
      if (popupTimer) { clearTimeout(popupTimer); popupTimer = null; }
      closePopup(false);
      closeTvPopup(false);
      closeHelp();
      var banner = document.getElementById('pwa-install-banner');
      if (banner) banner.remove();
    }
    if (changed) dispatchInstallState(installed, reason);
    return installed;
  }

  function isChromiumRuntime() {
    // Do not rely on Android/Mobile tokens here: Chrome DevTools device emulation
    // changes the page UA while the host browser (and installed PWA) stays desktop.
    if (isIOS()) return false;
    var brands = navigator.userAgentData && navigator.userAgentData.brands;
    if (Array.isArray(brands) && brands.some(function (item) {
      return /Chromium|Google Chrome|Microsoft Edge|Opera/i.test(item.brand || '');
    })) return true;
    return /(?:Chrome|Chromium|Edg|OPR)\//i.test(navigator.userAgent) &&
      !/(?:CriOS|EdgiOS|OPiOS)/i.test(navigator.userAgent);
  }

  function chromiumSuppressesInstallPrompt() {
    // Chromium does not consistently expose getInstalledRelatedApps() on desktop.
    // In a normal tab, an installed PWA suppresses beforeinstallprompt and Chrome
    // shows "Open in app" instead. The head listener is active before this check,
    // so a missing prompt means either already installed or not currently
    // installable; neither case should display our install promotion. If Chrome
    // emits the event later, mz:installready immediately changes the state to false.
    return isChromiumRuntime() && window.__mzPromptCaptureReady === true && !window.deferredPrompt;
  }

  function detectInstalledApp() {
    if (isStandalone()) {
      setInstalledMarker(true);
      return Promise.resolve(true);
    }
    // beforeinstallprompt proves that this browser can install the app now.
    if (window.deferredPrompt) {
      setInstalledMarker(false);
      return Promise.resolve(false);
    }
    if (typeof navigator.getInstalledRelatedApps === 'function') {
      return navigator.getInstalledRelatedApps().then(function (apps) {
        if (Array.isArray(apps) && apps.length > 0) {
          setInstalledMarker(true);
          return true;
        }
        // The API is absent or unreliable on desktop Chrome. Its empty result must
        // not override Chrome's stronger no-install-prompt/Open-in-app signal.
        if (chromiumSuppressesInstallPrompt()) return true;
        // On supported mobile Chromium, an empty successful result is uninstall
        // evidence and clears a marker left behind by a previous installation.
        setInstalledMarker(false);
        return false;
      }).catch(function () {
        return hasInstalledMarker() || chromiumSuppressesInstallPrompt();
      });
    }
    if (chromiumSuppressesInstallPrompt()) return Promise.resolve(true);
    // Safari and Firefox cannot query installation from a normal browser tab.
    return Promise.resolve(hasInstalledMarker());
  }

  function refreshInstalledState(reason, forcedValue) {
    var token = ++installedCheckToken;
    var result = typeof forcedValue === 'boolean' ? Promise.resolve(forcedValue) : detectInstalledApp();
    return result.then(function (installed) {
      if (token !== installedCheckToken) return installedState;
      return applyInstalledState(installed, reason);
    });
  }

  function checkAlreadyInstalled() {
    return refreshInstalledState('explicit-check');
  }

  window.__mzPwaInstallMonitor = {
    check: function () { return refreshInstalledState('external-check'); },
    refresh: function () { return refreshInstalledState('external-refresh'); },
    isInstalled: function () { return installedState === true; },
    getState: function () { return installedState; }
  };

  function openPopup(force) {
    if (!overlay || installedState === true) return;
    if (!force && popupShownThisLoad) return;
    if (installedState === null) {
      refreshInstalledState('popup-check').then(function (installed) { if (!installed) openPopup(force); });
      return;
    }
    popupShownThisLoad = true;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  window.__mzOpenInstallPopup = function () { openPopup(true); };

  function closePopup(remember) {
    if (!overlay) return;
    var wasOpen = overlay.classList.contains('open');
    overlay.classList.remove('open');
    if (wasOpen) document.body.style.overflow = '';
    if (remember) markDismissed(STORAGE_KEY);
  }

  function openTvPopup(force) {
    if (!tvOverlay || installedState === true) return;
    if (!force && popupShownThisLoad) return;
    popupShownThisLoad = true;
    tvOverlay.classList.add('open');
  }

  function closeTvPopup(remember) {
    if (!tvOverlay) return;
    tvOverlay.classList.remove('open');
    if (remember) markDismissed(TV_STORAGE_KEY);
  }

  /* QR CODE
   *
   *  This used to hit api.qrserver.com first and only fall back to the bundled
   *  generator in img.onerror. That was backwards, and measurably expensive:
   *  6 calls at ~739ms each on the install/TV surfaces, to a third-party host
   *  that needs its own DNS + TLS handshake, for data this file can already
   *  produce locally — MiniQR is bundled right above and is a good chunk of why
   *  this script is 30 KB.
   *
   *  Now MiniQR renders straight to a canvas: zero network, zero third party, no
   *  cold-connection latency, and it still works with no connection at all —
   *  which matters, because the TV overlay exists to be scanned by a phone when
   *  the TV itself cannot install the app.
   *
   *  The remote API is kept only for the case where MiniQR somehow is not on the
   *  page, so the surface degrades instead of showing an empty box.
   */
  var QR_API = 'https://api.qrserver.com/v1/create-qr-code/';

  function qrApiUrl(text, size) {
    return QR_API + '?size=' + size + 'x' + size +
      '&ecc=M&qzone=1&format=png&data=' + encodeURIComponent(text);
  }

  function currentUrl() {
    return window.location.href;
  }

  function renderQRLocal(el, text, opts) {
    if (!el || !window.MiniQR) return false;
    var canvas = document.createElement('canvas');
    try {
      window.MiniQR.renderTo(canvas, text, {
        cellSize: (opts && opts.cellSize) || 4,
        margin: (opts && opts.margin) || 8,
        dark: '#0a0a12', light: '#ffffff', level: 'M'
      });
      canvas.style.cssText = 'display:block;border-radius:6px;width:100%;height:100%;object-fit:contain;';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'QR code for ' + text);
      el.innerHTML = '';
      el.appendChild(canvas);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Kept under the old name too: other call sites and tests may reference it.
  function renderQRFallback(el, text, opts) {
    renderQRLocal(el, text, opts);
  }

  function renderQRRemote(el, text, opts) {
    var size = (opts && opts.size) || 200;
    var img = document.createElement('img');
    img.width = size;
    img.height = size;
    img.alt = 'QR code that opens ' + text;
    img.decoding = 'async';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.style.cssText = 'display:block;width:100%;height:100%;max-width:100%;border-radius:6px;background:#fff;object-fit:contain;';
    img.src = qrApiUrl(text, size);
    el.innerHTML = '';
    el.appendChild(img);
  }

  function renderQRInto(el, opts) {
    if (!el) return;
    opts = opts || {};
    var url = currentUrl();

    // Local first. Only reach the network if the bundled encoder is unavailable.
    if (renderQRLocal(el, url, opts)) return;
    renderQRRemote(el, url, opts);
  }

  // Keep the QR in sync with SPA-style URL changes so it never points at a stale page.
  function refreshAllQR() {
    if (qrWrap) renderQRInto(qrWrap, { size: 200 });
    if (tvQrWrap) renderQRInto(tvQrWrap, { size: 260, cellSize: 6, margin: 12 });
    var helpQr = document.getElementById('mzHelpQr');
    if (helpQr) renderQRInto(helpQr, { size: 160 });
  }
  window.addEventListener('hashchange', refreshAllQR);
  window.addEventListener('popstate', refreshAllQR);

  function setupIOSGuide() {
    if (iosGuide) iosGuide.style.display = 'flex';
    if (pwaDesc) pwaDesc.style.display = 'none';
    var body = qrWrap && qrWrap.closest ? qrWrap.closest('.pwa-body') : null;
    if (body) body.style.display = 'none';

    // Chrome/Firefox on iOS use a different share icon location/wording than Safari.
    if (iosShareLabel) iosShareLabel.textContent = 'Share';

    if (installBtn) {
      installBtn.textContent = 'Got it, thanks!';
      installBtn.addEventListener('click', function () { closePopup(true); });
    }
  }

  /* ── Install button state ─────────────────────────────────────────────── */
  var DEFAULT_BTN_LABEL = '⬇ Install Now';
  var clickBusy = false;

  function setBtn(label, opts) {
    if (!installBtn) return;
    opts = opts || {};
    installBtn.textContent = label;
    installBtn.disabled = !!opts.disabled;
    installBtn.style.opacity = opts.disabled ? '0.75' : '1';
    installBtn.style.cursor = opts.disabled ? 'progress' : 'pointer';
    if (opts.background) installBtn.style.background = opts.background;
  }

  function resetBtn() {
    if (!installBtn) return;
    installBtn.disabled = false;
    installBtn.textContent = DEFAULT_BTN_LABEL;
    installBtn.style.opacity = '1';
    installBtn.style.cursor = 'pointer';
    installBtn.style.background = '';
  }

  function toast(msg) {
    if (typeof window.showToast === 'function') window.showToast(msg);
  }

  /* ── Service Worker / installability bootstrap ─────────────────────────
     If beforeinstallprompt hasn't fired, the most common cause is that Chrome hasn't
     finished validating installability yet (no active SW, or manifest still loading).
     We register/activate the SW on demand, then wait briefly for the event. ── */
  function ensureServiceWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(false);

    var readyPromise = window.__mzServiceWorkerReady;
    if (!readyPromise) {
      // Defensive fallback for pages that load this script without index.html.
      readyPromise = navigator.serviceWorker.getRegistration()
        .then(function (reg) {
          return reg || navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
        })
        .then(function () { return navigator.serviceWorker.ready; });
    }

    return Promise.resolve(readyPromise)
      .then(function () {
        if (navigator.serviceWorker.controller) return true;
        if (typeof window.__mzAcquireServiceWorkerControl === 'function') {
          return window.__mzAcquireServiceWorkerControl();
        }
        return false;
      })
      .catch(function (err) {
        console.warn('[MovieZone PWA] SW bootstrap failed:', err);
        return false;
      });
  }

  // Resolves as soon as beforeinstallprompt lands, or after `timeout` ms.
  function waitForPrompt(timeout) {
    if (window.deferredPrompt) return Promise.resolve(window.deferredPrompt);
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        window.removeEventListener('mz:installready', finish);
        clearTimeout(timer);
        resolve(window.deferredPrompt || null);
      }
      var timer = setTimeout(finish, timeout);
      window.addEventListener('mz:installready', finish);
    });
  }

  /* ── Native Chrome/Edge install dialog ── */
  async function triggerNativePrompt() {
    var promptEvent = window.deferredPrompt;
    if (!promptEvent) return false;

    setBtn('⏳ Opening installer…', { disabled: true });
    try {
      await promptEvent.prompt();                    // native popup appears here
      var choice = await promptEvent.userChoice;     // { outcome, platform }
      console.log('[MovieZone PWA] Install choice:', choice && choice.outcome);

      window.deferredPrompt = null;                  // a prompt can only be used once

      if (choice && choice.outcome === 'accepted') {
        setBtn('✓ Installing…', { disabled: true, background: '#4ade80' });
        toast('MovieZone is installing! 🎬');
        markDismissed(STORAGE_KEY);
        setTimeout(function () { closePopup(false); }, 1200);
      } else {
        resetBtn();
        toast('Install cancelled — you can install any time.');
      }
      return true;
    } catch (err) {
      console.warn('[MovieZone PWA] prompt() failed:', err);
      window.deferredPrompt = null;
      resetBtn();
      return false;
    }
  }

  /* ── Fallback: no beforeinstallprompt available ──
     Never dead-ends with "use the address bar icon". Instead: bootstrap the SW,
     retry the native prompt, and only then show an actionable guide. ── */
  async function runFallbackInstallFlow() {
    if (isStandalone() || await alreadyInstalled()) {
      setBtn('✓ Already Installed', { disabled: true, background: '#4ade80' });
      setTimeout(function () { closePopup(true); }, 1500);
      return;
    }

    setBtn('⏳ Preparing install…', { disabled: true });
    await ensureServiceWorker();

    var promptEvent = await waitForPrompt(2500);

    if (promptEvent) {
      // The event arrived after asynchronous preparation, so transient user activation
      // may have expired. Never call prompt() here: require one fresh direct click.
      setBtn('⬇ Ready — tap to install');
      toast('Installer ready — tap Install Now once more.');
      return;
    }

    resetBtn();
    showInstallHelp();
  }

  // Reuse the shared monitor so popup, navbar, and fallback flow always agree.
  function alreadyInstalled() {
    return checkAlreadyInstalled();
  }

  /* Installability diagnostics */
  function probeImage(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = function () { resolve({ ok: false, w: 0, h: 0 }); };
      img.src = url + (url.indexOf('?') > -1 ? '&' : '?') + 'mzdiag=' + Date.now();
    });
  }

  async function runInstallDiagnostics() {
    var rows = [];
    function add(check, ok, detail, status) {
      rows.push({
        check: check,
        ok: !!ok,
        detail: detail || '',
        status: status || (ok ? 'pass' : 'fail')
      });
    }

    add('Secure context (HTTPS or localhost)', window.isSecureContext,
      location.protocol + '//' + location.host);

    var link = document.querySelector('link[rel="manifest"]');
    add('<link rel="manifest"> in <head>', !!link, link ? link.getAttribute('href') : 'MISSING');

    var manifest = null;
    if (link) {
      try {
        var res = await fetch(link.href, { cache: 'no-store' });
        add('Manifest HTTP fetch', res.ok,
          res.status + ' · ' + (res.headers.get('content-type') || 'no content-type'));
        if (res.ok) {
          try {
            manifest = await res.json();
            add('Manifest is valid JSON', true, Object.keys(manifest).length + ' keys');
          } catch (e) { add('Manifest is valid JSON', false, e.message); }
        }
      } catch (e) { add('Manifest HTTP fetch', false, e.message); }
    }

    if (manifest) {
      ['name', 'short_name', 'start_url', 'display', 'icons'].forEach(function (k) {
        add('manifest.' + k, !!manifest[k], manifest[k] ? String(
          Array.isArray(manifest[k]) ? manifest[k].length + ' entries' : manifest[k]
        ) : 'MISSING');
      });

      var displayOk = ['standalone', 'fullscreen', 'minimal-ui'].indexOf(manifest.display) > -1;
      add('display is app-like', displayOk, manifest.display || '—');

      // Chrome needs a fetchable 192px AND 512px any-purpose icon.
      var icons = (manifest.icons || []).filter(function (i) {
        return !i.purpose || i.purpose.split(' ').indexOf('any') > -1;
      });
      var probes = await Promise.all(icons.map(function (i) {
        return probeImage(new URL(i.src, link.href).href).then(function (r) {
          return { src: i.src, declared: i.sizes, real: r };
        });
      }));
      probes.forEach(function (p) {
        add('icon ' + p.src, p.real.ok, p.real.ok ? p.real.w + '×' + p.real.h + ' (declared ' + p.declared + ')' : 'FAILED TO LOAD');
      });
      var has192 = probes.some(function (p) { return p.real.ok && p.real.w >= 192; });
      var has512 = probes.some(function (p) { return p.real.ok && p.real.w >= 512; });
      add('icon ≥192px usable', has192);
      add('icon ≥512px usable', has512);
    }

    if ('serviceWorker' in navigator) {
      var reg = await navigator.serviceWorker.getRegistration();
      add('Service worker registered', !!reg, reg ? 'scope ' + reg.scope : 'none');
      add('Service worker active', !!(reg && reg.active), reg && reg.active ? reg.active.state : '—');
      add('Page is SW-controlled', !!navigator.serviceWorker.controller,
        navigator.serviceWorker.controller ? 'yes' : 'no — reload once after first install');
    } else {
      add('Service worker API', false, 'unsupported');
    }

    var installedApps = [];
    if (navigator.getInstalledRelatedApps) {
      try { installedApps = await navigator.getInstalledRelatedApps(); } catch (e) {}
    }
    add('App NOT already installed', installedApps.length === 0,
      installedApps.length
        ? 'ALREADY INSTALLED → Chrome suppresses the prompt'
        : 'not reported as installed (Chrome may still track an existing desktop install)');
    add('Running in a browser tab', !isStandalone(),
      isStandalone() ? 'already standalone' : 'browser tab');
    add('beforeinstallprompt received', !!window.deferredPrompt,
      window.deferredPrompt
        ? 'ready'
        : 'waiting — Chrome may withhold it for engagement threshold, dismissal cooldown, private/guest mode, or browser policy',
      window.deferredPrompt ? 'pass' : 'pending');
    add('Browser-controlled install policy', true,
      'JavaScript cannot synthesize the native prompt or detect every suppression reason',
      'info');

    console.table(rows);
    return rows;
  }

  window.mzInstallDiagnostics = runInstallDiagnostics;

  function renderDiagnostics(rows) {
    var host = document.getElementById('mzHelpDiag');
    if (!host) return;
    var failed = rows.filter(function (r) { return r.status === 'fail'; });
    var pending = rows.filter(function (r) { return r.status === 'pending'; });
    var verdict;
    if (failed.length) {
      verdict = '<b>' + failed.length + ' blocking check' + (failed.length > 1 ? 's' : '') + ' failed.</b> Resolve ' +
        (failed.length > 1 ? 'these' : 'this') + ' before installation can work.';
    } else if (pending.length) {
      verdict = '<b>Install requirements pass.</b> Chrome has not exposed the native prompt yet.';
    } else {
      verdict = '<b>All install criteria pass.</b> The native installer is ready.';
    }
    host.innerHTML =
      '<div class="mz-diag"><p class="mz-diag-verdict">' + verdict + '</p><ul>' +
      rows.map(function (r) {
        var symbol = r.status === 'pass' ? '✓' : (r.status === 'fail' ? '✕' : (r.status === 'pending' ? '…' : 'i'));
        return '<li class="' + r.status + '"><span>' + symbol + '</span>' +
          '<span>' + r.check + (r.detail ? ' <em>' + r.detail + '</em>' : '') + '</span></li>';
      }).join('') +
      '</ul><p class="mz-help-note">Full table also logged to the DevTools console.</p></div>';
  }

  /* ── Manual install guide (browser-aware) ─────────────────────────────── */
  function detectBrowser() {
    var ua = navigator.userAgent;
    var isAndroid = /Android/.test(ua);
    if (/Edg\//.test(ua)) return { name: 'Edge', key: 'edge', android: isAndroid };
    if (/OPR\//.test(ua) || /Opera/.test(ua)) return { name: 'Opera', key: 'opera', android: isAndroid };
    if (/SamsungBrowser/.test(ua)) return { name: 'Samsung Internet', key: 'samsung', android: isAndroid };
    if (/Firefox\//.test(ua)) return { name: 'Firefox', key: 'firefox', android: isAndroid };
    if (/Chrome\//.test(ua)) return { name: 'Chrome', key: 'chrome', android: isAndroid };
    if (/Safari\//.test(ua)) return { name: 'Safari', key: 'safari', android: false };
    return { name: 'your browser', key: 'other', android: isAndroid };
  }

  function installSteps(b) {
    if (b.android) {
      return [
        'Tap the <b>⋮</b> menu (top-right of ' + b.name + ')',
        'Choose <b>“Add to Home screen”</b> or <b>“Install app”</b>',
        'Confirm with <b>Install</b> — MovieZone lands on your home screen'
      ];
    }
    switch (b.key) {
      case 'edge':
        return [
          'Open the <b>⋯</b> menu (top-right)',
          'Go to <b>Apps → Install this site as an app</b>',
          'Click <b>Install</b>'
        ];
      case 'chrome':
        return [
          'Open the <b>⋮</b> menu (top-right)',
          'Choose <b>Cast, save and share → Install page as app</b><br><span class="mz-help-note">(older Chrome: <b>Save and share → Install page as app</b>)</span>',
          'Click <b>Install</b>'
        ];
      case 'opera':
        return [
          'Open the <b>Opera</b> menu',
          'Choose <b>Install MovieZone…</b> or <b>Add to… → Install as app</b>',
          'Confirm the install'
        ];
      case 'safari':
        return [
          'Open the <b>File</b> menu',
          'Choose <b>Add to Dock…</b>',
          'Click <b>Add</b>'
        ];
      case 'firefox':
        return [
          'Firefox on desktop can’t install web apps yet',
          'Scan the QR code with your phone to install there, or',
          'Reopen this page in <b>Chrome</b> or <b>Edge</b> to install on this device'
        ];
      default:
        return [
          'Open your browser’s main menu',
          'Look for <b>Install app</b> or <b>Add to Home screen</b>',
          'Or scan the QR code to install on your phone'
        ];
    }
  }

  function injectHelpStyles() {
    if (document.getElementById('mz-install-help-styles')) return;
    var s = document.createElement('style');
    s.id = 'mz-install-help-styles';
    s.textContent = [
      '#mzInstallHelp{position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;',
      'background:rgba(3,3,10,.82);backdrop-filter:blur(8px);padding:20px;overflow-y:auto;}',
      '#mzInstallHelp.open{display:flex;}',
      '#mzInstallHelp .mz-help-card{position:relative;width:100%;max-width:460px;background:#0d0d18;',
      'border:1px solid rgba(245,197,24,.28);border-radius:18px;padding:26px 24px;color:#f2f2f5;',
      'box-shadow:0 30px 80px rgba(0,0,0,.6);font-family:inherit;}',
      '#mzInstallHelp h3{margin:0 0 6px;font-size:1.18rem;color:#f5c518;}',
      '#mzInstallHelp p{margin:0 0 16px;font-size:.9rem;line-height:1.55;color:#b9b9c6;}',
      '#mzInstallHelp ol{margin:0 0 18px;padding-left:0;list-style:none;counter-reset:mzstep;}',
      '#mzInstallHelp ol li{counter-increment:mzstep;position:relative;padding:10px 0 10px 40px;font-size:.9rem;',
      'line-height:1.5;border-bottom:1px solid rgba(255,255,255,.06);}',
      '#mzInstallHelp ol li:last-child{border-bottom:0;}',
      '#mzInstallHelp ol li::before{content:counter(mzstep);position:absolute;left:0;top:9px;width:26px;height:26px;',
      'border-radius:50%;background:rgba(245,197,24,.14);color:#f5c518;font-size:.78rem;font-weight:700;',
      'display:flex;align-items:center;justify-content:center;}',
      '#mzInstallHelp .mz-help-note{color:#8f8fa0;font-size:.78rem;}',
      '#mzInstallHelp .mz-help-qr{display:flex;gap:14px;align-items:center;background:rgba(255,255,255,.04);',
      'border-radius:12px;padding:12px;margin-bottom:18px;}',
      '#mzInstallHelp .mz-help-qr span{font-size:.8rem;color:#b9b9c6;line-height:1.45;}',
      '#mzInstallHelp .mz-help-actions{display:flex;gap:10px;flex-wrap:wrap;}',
      '#mzInstallHelp button{flex:1 1 140px;padding:12px 16px;border-radius:10px;font-size:.88rem;font-weight:600;',
      'cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#f2f2f5;}',
      '#mzInstallHelp button.mz-help-primary{background:linear-gradient(135deg,#f5c518,#e0a800);color:#1a1400;border:0;}',
      '#mzInstallHelp button:focus-visible{outline:2px solid #f5c518;outline-offset:2px;}',
      '#mzInstallHelp .mz-help-close{position:absolute;top:12px;right:12px;flex:0 0 auto;width:34px;height:34px;',
      'padding:0;border-radius:50%;font-size:1.1rem;line-height:1;}',
      '#mzInstallHelp .mz-diag{margin-top:16px;border-top:1px solid rgba(255,255,255,.08);padding-top:14px;}',
      '#mzInstallHelp .mz-diag-verdict{font-size:.85rem;color:#e6e6ee;margin-bottom:10px;}',
      '#mzInstallHelp .mz-diag ul{list-style:none;margin:0 0 8px;padding:0;counter-reset:none;',
      'max-height:220px;overflow-y:auto;}',
      '#mzInstallHelp .mz-diag li{display:flex;gap:8px;align-items:flex-start;padding:5px 0;font-size:.8rem;',
      'border:0;line-height:1.4;}',
      '#mzInstallHelp .mz-diag li::before{content:none;}',
      '#mzInstallHelp .mz-diag li.pass>span:first-child{color:#4ade80;}',
      '#mzInstallHelp .mz-diag li.fail>span:first-child{color:#f87171;}',
      '#mzInstallHelp .mz-diag li.fail{color:#fca5a5;}',
      '#mzInstallHelp .mz-diag li.pending>span:first-child{color:#f5c518;}',
      '#mzInstallHelp .mz-diag li.pending{color:#fde68a;}',
      '#mzInstallHelp .mz-diag li.info>span:first-child{color:#60a5fa;}',
      '#mzInstallHelp .mz-diag em{color:#8f8fa0;font-style:normal;}'
    ].join('');
    document.head.appendChild(s);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (e) { reject(e); }
    });
  }

  function closeHelp() {
    var panel = document.getElementById('mzInstallHelp');
    if (panel) panel.classList.remove('open');
    document.body.style.overflow = '';
  }

  function showInstallHelp() {
    injectHelpStyles();
    var b = detectBrowser();
    var insecure = location.protocol !== 'https:' &&
      location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';

    var panel = document.getElementById('mzInstallHelp');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'mzInstallHelp';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-labelledby', 'mzHelpTitle');
      document.body.appendChild(panel);
    }

    var steps = installSteps(b).map(function (s) { return '<li>' + s + '</li>'; }).join('');
    var warning = insecure
      ? '<p class="mz-help-note">⚠ This page is served over <b>' + location.protocol +
        '</b>. Browsers only allow app install over <b>HTTPS</b> (or localhost).</p>'
      : '';

    panel.innerHTML =
      '<div class="mz-help-card">' +
        '<button class="mz-help-close" id="mzHelpClose" aria-label="Close">&times;</button>' +
        '<h3 id="mzHelpTitle">Install MovieZone on ' + b.name + '</h3>' +
        '<p>Your browser didn’t offer the one-click installer for this page. It takes two taps instead:</p>' +
        '<ol>' + steps + '</ol>' +
        warning +
        '<div class="mz-help-qr"><div id="mzHelpQr"></div>' +
          '<span><b>Or install on your phone</b><br>Scan this code to open this exact page on mobile, then tap “Install app”.</span>' +
        '</div>' +
        '<div class="mz-help-actions">' +
          '<button class="mz-help-primary" id="mzHelpRetry">↻ Retry one-click install</button>' +
          '<button id="mzHelpDiagBtn">🔍 Why not?</button>' +
          '<button id="mzHelpApps">Copy chrome://apps</button>' +
        '</div>' +
        '<div id="mzHelpDiag"></div>' +
      '</div>';

    renderQRInto(document.getElementById('mzHelpQr'), { size: 160, cellSize: 3, margin: 6 });

    document.getElementById('mzHelpClose').addEventListener('click', closeHelp);
    panel.addEventListener('click', function (e) { if (e.target === panel) closeHelp(); });

    // Retry uses a strict two-phase flow: if Chrome already exposed the event,
    // prompt immediately in this click. If it arrives after async checks, ask for
    // one more click so transient user activation is guaranteed.
    document.getElementById('mzHelpRetry').addEventListener('click', async function () {
      var btn = this;

      if (window.deferredPrompt) {
        closeHelp();
        await triggerNativePrompt();
        return;
      }

      btn.disabled = true;
      btn.textContent = '⏳ Checking installer…';
      await ensureServiceWorker();
      var p = await waitForPrompt(2500);
      if (p) {
        btn.disabled = false;
        btn.textContent = '✓ Ready — click to install';
        toast('Native installer ready — click the button once more.');
      } else {
        btn.disabled = false;
        btn.textContent = '↻ Retry one-click install';
        var rows = await runInstallDiagnostics();
        renderDiagnostics(rows);
        toast('Chrome is still withholding the native prompt; see the policy details below.');
      }
    });

    // Report exactly which installability criterion is failing.
    document.getElementById('mzHelpDiagBtn').addEventListener('click', async function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = '🔍 Checking…';
      try {
        var rows = await runInstallDiagnostics();
        renderDiagnostics(rows);
      } catch (e) {
        console.warn('[MovieZone PWA] Diagnostics failed:', e);
      }
      btn.disabled = false;
      btn.textContent = '🔍 Why not?';
    });

    // Browsers block scripted navigation to chrome:// URLs, so hand the user the
    // address instead: one paste in the address bar opens the installed-apps page.
    document.getElementById('mzHelpApps').addEventListener('click', function () {
      var btn = this;
      copyText('chrome://apps').then(function () {
        btn.textContent = '✓ Copied — paste in address bar';
        toast('Paste chrome://apps in the address bar to manage installed apps.');
      }).catch(function () {
        btn.textContent = 'Open chrome://apps manually';
      });
    });

    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape' && panel.classList.contains('open')) {
        closeHelp();
        document.removeEventListener('keydown', onEsc);
      }
    });

    panel.classList.add('open');
    var retry = document.getElementById('mzHelpRetry');
    if (retry) retry.focus();
  }

  /* ── Click handler ── */
  async function handleInstallClick() {
    if (clickBusy) return;
    clickBusy = true;
    try {
      if (window.deferredPrompt) {
        var ok = await triggerNativePrompt();
        if (!ok) await runFallbackInstallFlow();
      } else {
        await runFallbackInstallFlow();
      }
    } catch (err) {
      console.warn('[MovieZone PWA] Install flow error:', err);
      resetBtn();
      showInstallHelp();
    } finally {
      clickBusy = false;
    }
  }

  function setupInstallButton() {
    if (!installBtn) return;

    if (isIOS()) {
      setupIOSGuide();
      return;
    }

    installBtn.addEventListener('click', handleInstallClick);
  }

  // Any external caller (navbar button, banner) routes through the same flow.
  window.__mzTriggerInstall = handleInstallClick;
  window.__mzShowInstallHelp = showInstallHelp;

  function scheduleInstallPopup(delay) {
    // Auto-open only on the visitor's first-ever visit (nothing recorded under
    // STORAGE_KEY yet). Every later visit skips straight past this — the
    // popup no longer appears on every refresh. The navbar Install button
    // stays visible and clickable the whole time via handleInstallClick, so
    // the user can still open it manually whenever they want, right up until
    // the app is actually installed (applyInstalledState hides that button).
    if (installedState === true || popupShownThisLoad || popupTimer) return;
    if (isMzTV() ? hasTvAutoPopupBeenShown() : hasAutoPopupBeenShown()) return;
    popupTimer = setTimeout(function () {
      popupTimer = null;
      refreshInstalledState('before-auto-popup').then(function (installed) {
        if (installed || popupShownThisLoad) return;
        if (isMzTV() ? hasTvAutoPopupBeenShown() : hasAutoPopupBeenShown()) return;
        markDismissed(isMzTV() ? TV_STORAGE_KEY : STORAGE_KEY);
        if (isMzTV()) {
          openTvPopup(false);
          setTimeout(function () { if (tvDismissBtn) tvDismissBtn.focus(); }, 100);
        } else openPopup(false);
      });
    }, typeof delay === 'number' ? delay : SHOW_DELAY_MS);
  }

  function prepareUninstalledUI() {
    if (installedState === true) return;
    if (isMzTV()) {
      if (!tvOverlay) { console.log('[MovieZone PWA] TV overlay element not found in DOM.'); return; }
      if (!tvUiPrepared) {
        tvUiPrepared = true;
        renderQRInto(tvQrWrap, { size: 260, cellSize: 6, margin: 12 });
        if (tvDismissBtn) {
          tvDismissBtn.addEventListener('click', function () { closeTvPopup(false); });
          tvDismissBtn.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') closeTvPopup(false);
          });
        }
      }
      scheduleInstallPopup(SHOW_DELAY_MS);
      return;
    }
    if (!overlay) { console.log('[MovieZone PWA] Popup overlay element not found in DOM.'); return; }
    if (!uiPrepared) {
      uiPrepared = true;
      setupInstallButton();
      renderQRInto(qrWrap, { size: 200 });
      if (laterBtn) laterBtn.addEventListener('click', function () { closePopup(false); });
      if (closeBtn) closeBtn.addEventListener('click', function () { closePopup(false); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) closePopup(false); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && overlay.classList.contains('open')) closePopup(false);
      });
    }
    scheduleInstallPopup(SHOW_DELAY_MS);
  }

  window.addEventListener('mz:installready', function () {
    setInstalledMarker(false);
    refreshInstalledState('native-prompt-ready', false).then(function () {
      if (installBtn && !clickBusy && !isIOS()) resetBtn();
      prepareUninstalledUI();
      if (popupTimer) { clearTimeout(popupTimer); popupTimer = null; }
      setTimeout(function () { if (isMzTV()) openTvPopup(false); else openPopup(false); }, 250);
    });
  });

  window.addEventListener('appinstalled', function () {
    markDismissed(STORAGE_KEY);
    window.deferredPrompt = null;
    setInstalledMarker(true);
    refreshInstalledState('appinstalled', true);
    toast('MovieZone installed!');
  });

  function startInstallMonitoring() {
    if (monitorStarted) return;
    monitorStarted = true;
    ['(display-mode: standalone)', '(display-mode: fullscreen)'].forEach(function (query) {
      var media = window.matchMedia(query);
      var onChange = function () { refreshInstalledState('display-mode-change'); };
      if (media.addEventListener) media.addEventListener('change', onChange);
      else if (media.addListener) media.addListener(onChange);
    });
    window.addEventListener('pageshow', function () { refreshInstalledState('pageshow'); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshInstalledState('visibility');
    });
    setInterval(function () { refreshInstalledState('periodic-monitor'); }, 30000);
  }

  function init() {
    overlay = document.getElementById('pwa-install-overlay');
    installBtn = document.getElementById('pwaInstallBtn');
    laterBtn = document.getElementById('pwaLaterBtn');
    closeBtn = document.getElementById('pwaCloseBtn');
    iosGuide = document.getElementById('pwaIosGuide');
    iosShareLabel = document.getElementById('pwaIosShareLabel');
    pwaDesc = document.getElementById('pwaDesc');
    qrWrap = document.getElementById('pwaQrWrap');
    tvOverlay = document.getElementById('pwa-install-tv-overlay');
    tvQrWrap = document.getElementById('pwaTvQrWrap');
    tvDismissBtn = document.getElementById('pwaTvDismissBtn');

    startInstallMonitoring();
    refreshInstalledState('initial-load').then(function (installed) {
      if (installed) {
        console.log('[MovieZone PWA] Install UI hidden: app is already installed.');
        return;
      }
      console.log('[MovieZone PWA] App not installed: button visible; popup opens on this refresh.');
      prepareUninstalledUI();
    });
  }

  // Script is loaded with `defer`, but run immediately if the DOM is already parsed.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
