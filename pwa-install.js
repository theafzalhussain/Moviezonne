/* ==========================================================================
   MovieZone — Premium PWA Install Prompt
   - Shows a delayed, luxury install popup with QR code
   - Handles Android/Windows/Desktop (beforeinstallprompt), iOS (manual steps),
     and hides gracefully on unsupported platforms (Smart TVs, already-installed)
   - QR code is generated fully client-side (qrcode-generator, MIT licensed,
     inlined below) — no third-party network requests, no user data leaves device
   ========================================================================== */

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
        var byteArray = [];
        var code = this.data.charCodeAt(i);
        if (code > 0x10000) {
          byteArray[0] = 0xF0 | ((code & 0x1C0000) >>> 18);
          byteArray[1] = 0x80 | ((code & 0x3F000) >>> 12);
          byteArray[2] = 0x80 | ((code & 0xFC0) >>> 6);
          byteArray[3] = 0x80 | (code & 0x3F);
        } else if (code > 0x800) {
          byteArray[0] = 0xE0 | ((code & 0xF000) >>> 12);
          byteArray[1] = 0x80 | ((code & 0xFC0) >>> 6);
          byteArray[2] = 0x80 | (code & 0x3F);
        } else if (code > 0x80) {
          byteArray[0] = 0xC0 | ((code & 0x7C0) >>> 6);
          byteArray[1] = 0x80 | (code & 0x3F);
        } else {
          byteArray[0] = code;
        }
        this.parsedData.push.apply(this.parsedData, byteArray);
      }
      if (this.parsedData.length >= 2) {
        this.parsedData.splice(this.parsedData.length - 2, 2);
      } else {
        this.parsedData = [];
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
  var SHOW_DELAY_MS = 4000;
  var SNOOZE_DAYS = 7;

  var overlay, installBtn, laterBtn, closeBtn, iosSteps, qrWrap;
  var deferredPrompt = null;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true; // iOS Safari
  }

  function isTV() {
    var ua = navigator.userAgent.toLowerCase();
    return /smart-tv|smarttv|googletv|appletv|hbbtv|netcast|viera|tizen.*tv|webos.*tv|tv.*webos/.test(ua);
  }

  function isIOS() {
    var ua = navigator.userAgent;
    return /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  }

  function recentlyDismissed() {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    var dismissedAt = parseInt(raw, 10);
    if (isNaN(dismissedAt)) return false;
    var elapsedDays = (Date.now() - dismissedAt) / (1000 * 60 * 60 * 24);
    return elapsedDays < SNOOZE_DAYS;
  }

  function markDismissed() {
    try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch (e) {}
  }

  function openPopup() {
    if (!overlay) return;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closePopup(remember) {
    if (!overlay) return;
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    if (remember) markDismissed();
  }

  function renderQR() {
    if (!qrWrap || !window.MiniQR) return;
    var canvas = document.createElement('canvas');
    try {
      window.MiniQR.renderTo(canvas, window.location.origin + '/', {
        cellSize: 4, margin: 8, dark: '#0a0a12', light: '#ffffff', level: 'M'
      });
      qrWrap.innerHTML = '';
      qrWrap.appendChild(canvas);
    } catch (e) {
      qrWrap.innerHTML = '';
    }
  }

  function setupInstallButton() {
    if (isIOS()) {
      // iOS has no programmatic install — show manual instructions instead.
      iosSteps.style.display = 'block';
      installBtn.textContent = 'Got it';
      installBtn.addEventListener('click', function () { closePopup(true); });
      return;
    }

    installBtn.addEventListener('click', function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function () {
          deferredPrompt = null;
          closePopup(true);
        });
      } else {
        // No native prompt available (already installed, unsupported browser,
        // or criteria not met yet) — keep popup open with QR fallback visible.
        closePopup(true);
      }
    });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
  });

  window.addEventListener('appinstalled', function () {
    markDismissed();
    closePopup(false);
  });

  document.addEventListener('DOMContentLoaded', function () {
    overlay = document.getElementById('pwa-install-overlay');
    installBtn = document.getElementById('pwaInstallBtn');
    laterBtn = document.getElementById('pwaLaterBtn');
    closeBtn = document.getElementById('pwaCloseBtn');
    iosSteps = document.getElementById('pwaIosSteps');
    qrWrap = document.getElementById('pwaQrWrap');

    if (!overlay) return;

    if (isStandalone() || isTV() || recentlyDismissed()) return;

    setupInstallButton();
    renderQR();

    laterBtn.addEventListener('click', function () { closePopup(true); });
    closeBtn.addEventListener('click', function () { closePopup(true); });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closePopup(true);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('open')) closePopup(true);
    });

    setTimeout(openPopup, SHOW_DELAY_MS);
  });
})();
