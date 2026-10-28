/**
 * PWA Scan Sheet - Main Application Logic
 * Supports 100% Offline, Arabic-only, Dark/Light mode, Desktop Guard,
 * Full-name duplicate detection, Score-based sorting & coloring, CSV & Multi-sheet XLSX export.
 */

// State Management
let scannedStudents = [];
let html5QrCode = null;
let currentCameraId = null;
let availableCameras = [];
let isTorchOn = false;
let activeClassFilter = 'ALL';
let isScanning = false;

// Audio Synthesizer Context (Web Audio API - Zero external files)
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

// Silent Audio handlers (Scan sound muted per user preference; tactile vibration only)
function playSuccessSound() { }
function playWarningSound() { }

// Trigger tactile vibration (silent, vibration only)
function triggerVibrate(pattern) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch (e) { }
  }
}

// Arabic text normalizer for accurate full name matching
function normalizeArabic(text) {
  if (!text) return '';
  return text
    .toString()
    .trim()
    .replace(/[\u064B-\u065F]/g, '') // Remove tashkeel/diacritics
    .replace(/[إأآا]/g, 'ا')        // Normalize alef
    .replace(/ة/g, 'ه')             // Normalize taa marbuta
    .replace(/[\s\t\n\r]+/g, ' ')    // Collapse whitespace
    .toLowerCase();
}

// Digits normalizer (converts Eastern Arabic ٠-٩ and Persian ۰-۹ to Western 0-9)
function normalizeDigits(str) {
  if (!str) return '';
  return str
    .toString()
    .replace(/[٠۰]/g, '0')
    .replace(/[١۱]/g, '1')
    .replace(/[٢۲]/g, '2')
    .replace(/[٣۳]/g, '3')
    .replace(/[٤۴]/g, '4')
    .replace(/[٥۵]/g, '5')
    .replace(/[٦۶]/g, '6')
    .replace(/[٧۷]/g, '7')
    .replace(/[٨۸]/g, '8')
    .replace(/[٩۹]/g, '9');
}

// HTML escape helper
function escapeHtml(str) {
  if (!str) return '';
  return str.toString().replace(/[&<>"']/g, function (m) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m];
  });
}

// Classic Loved Bottom Pill Toast Notification with Haptic Vibration
function showToast(content, type = 'info') {
  const toast = document.getElementById('app-toast');
  if (!toast) return;

  clearTimeout(toast._timer);

  let message = '';
  if (typeof content === 'object' && content !== null) {
    if (content.type) type = content.type;
    message = content.message || content.title || '';
    if (content.score !== undefined && content.score !== null) {
      message += ` (${content.score}/20)`;
    }
  } else {
    message = String(content || '');
  }

  // Prepend clean status icon if not present
  let icon = '';
  if (type === 'success' && !message.includes('✅')) {
    icon = '✅ ';
  } else if ((type === 'duplicate' || type === 'warning') && !message.includes('⚠️')) {
    icon = '⚠️ ';
  } else if ((type === 'danger' || type === 'error') && !message.includes('❌')) {
    icon = '❌ ';
  }

  // Haptic feedback vibration for enhanced UX:
  // Warnings (table empty, camera paused, no data to export, flashlight notice) trigger distinct tactile pulse
  const isWarningNotice = (
    type === 'warning' ||
    type === 'duplicate' ||
    type === 'danger' ||
    type === 'error' ||
    message.includes('فارغ') ||
    message.includes('إيقاف') ||
    message.includes('لا توجد') ||
    message.includes('غير مدعوم') ||
    message.includes('تعذر') ||
    message.includes('حظر') ||
    message.includes('يجب')
  );

  if (isWarningNotice) {
    triggerVibrate([70, 50, 70]); // Double tactile warning pulse
  } else if (type === 'success') {
    triggerVibrate(40); // Soft confirmation tap
  }

  toast.className = `toast-notice ${type} show`;
  toast.innerHTML = `<span>${icon}${escapeHtml(message)}</span>`;

  toast._timer = setTimeout(() => {
    toast.className = 'toast-notice';
  }, 3200);
}

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadData();
  setupEventListeners();
  initScannerFlow();
  registerServiceWorker();
});

// PWA Service Worker Registration
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js?v=20261028', { scope: '/' })
      .then(reg => {
        console.log('ServiceWorker registered successfully:', reg.scope);
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                newWorker.postMessage({ type: 'SKIP_WAITING' });
              }
            });
          }
        });
      })
      .catch(err => console.warn('ServiceWorker registration error:', err));
  }
}

// Theme handling (Automatic Browser Detection + Dynamic Sync + Manual Toggle)
function initTheme() {
  const mediaQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const savedTheme = localStorage.getItem('pwa_scan_theme');

  // Automatically detect based on browser preference by default
  const browserTheme = (mediaQuery && mediaQuery.matches) ? 'dark' : 'light';
  const initialTheme = savedTheme || browserTheme;

  applyTheme(initialTheme);

  // Auto-sync with browser/operating system theme changes
  if (mediaQuery) {
    const handleBrowserThemeChange = (e) => {
      // If user has not explicitly locked a manual preference, follow browser dynamically
      if (!localStorage.getItem('pwa_scan_theme_manual')) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleBrowserThemeChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(handleBrowserThemeChange);
    }
  }

  const themeBtn = document.getElementById('btn-toggle-theme');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem('pwa_scan_theme', next);
      localStorage.setItem('pwa_scan_theme_manual', 'true');
      triggerVibrate(35); // Soft tactile feedback on theme toggle
    });
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);

  // Keep mobile Status Bar and Navigation Bar background color identical to page background
  const bgColor = theme === 'dark' ? '#0b1120' : '#f8fafc';
  const metaColor = document.getElementById('meta-theme-color');
  if (metaColor) {
    metaColor.setAttribute('content', bgColor);
  }

  // Update Apple status bar meta
  const appleMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (appleMeta) {
    appleMeta.setAttribute('content', theme === 'dark' ? 'black-translucent' : 'default');
  }

  const icon = document.getElementById('theme-icon');
  if (icon) {
    // Show sun in dark mode, moon in light mode
    icon.innerHTML = theme === 'dark'
      ? '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
  }
}

// Local Storage & Data Handling
function loadData() {
  try {
    const raw = localStorage.getItem('pwa_scanned_students');
    scannedStudents = raw ? JSON.parse(raw) : [];
  } catch (e) {
    scannedStudents = [];
  }
  renderUI();
}

function saveData() {
  localStorage.setItem('pwa_scanned_students', JSON.stringify(scannedStudents));
}

// Sorting logic for UI dashboard: Highest mark first; if equal, alphabetical by full name
function getSortedStudents(list) {
  return [...list].sort((a, b) => {
    const scoreDiff = parseFloat(b.score) - parseFloat(a.score);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return (a.fullName || '').localeCompare(b.fullName || '', 'ar');
  });
}

// Export Sorting Logic: Full Name in Arabic Ascending Order (أ -> ي)
function getExportSortedStudents(list) {
  return [...list].sort((a, b) => {
    const nameA = (a.fullName || '').trim();
    const nameB = (b.fullName || '').trim();
    const nameDiff = nameA.localeCompare(nameB, 'ar');
    if (nameDiff !== 0) {
      return nameDiff;
    }
    return parseFloat(b.score) - parseFloat(a.score);
  });
}

// Robust parser for student QR code data
// Primary Format:
// الاسم الكامل: أحمد بن علي
// القسم : 1ع1
// العلامة: 18/20
function parseStudentQRData(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  const normalized = normalizeDigits(rawText.trim());

  let fullName = '';
  let className = '';
  let score = NaN;

  // 1. Line-by-line parsing for exact Arabic structured text
  const lines = normalized.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Full name match (e.g. "الاسم الكامل: أحمد بن علي" or "الاسم : ...")
    const nameMatch = trimmed.match(/^(?:الاسم\s*الكامل|الاسم\s*واللقب|اسم\s*التلميذ|الاسم|Name)\s*[:：]\s*(.+)$/i);
    if (nameMatch) {
      fullName = nameMatch[1].trim();
      continue;
    }

    // Class name match (e.g. "القسم : 1ع1" or "القسم: 1ع1")
    const classMatch = trimmed.match(/^(?:القسم|الفوج|الصف|المستوى|Class|Group)\s*[:：]\s*(.+)$/i);
    if (classMatch) {
      className = classMatch[1].trim();
      continue;
    }

    // Score / Mark match (e.g. "العلامة: 18/20" or "العلامة : 18/20" or "النقطة: 18")
    const scoreMatch = trimmed.match(/^(?:العلامة|النقطة|الدرجة|المعدل|Score|Mark)\s*[:：]\s*(.+)$/i);
    if (scoreMatch) {
      const rawScoreVal = scoreMatch[1].trim();
      // Extract numeric mark before /20 or standalone
      const numMatch = rawScoreVal.match(/([0-9]+(?:[\.,][0-9]+)?)/);
      if (numMatch) {
        score = parseFloat(numMatch[1].replace(',', '.'));
      }
      continue;
    }
  }

  // If found structured fields
  if (fullName && !isNaN(score)) {
    return {
      fullName,
      className: className || 'عام',
      score
    };
  }

  // 2. Multiline/inline match if text has delimiters or no newlines
  const mName = normalized.match(/(?:الاسم\s*الكامل|الاسم\s*واللقب|اسم\s*التلميذ|الاسم|Name)\s*[:：]\s*([^\r\n;,|]+)/i);
  const mClass = normalized.match(/(?:القسم|الفوج|الصف|المستوى|Class|Group)\s*[:：]\s*([^\r\n;,|]+)/i);
  const mScore = normalized.match(/(?:العلامة|النقطة|الدرجة|المعدل|Score|Mark)\s*[:：]\s*([^\r\n;,|]+)/i);

  if (mName && mScore) {
    const sStr = mScore[1].trim();
    const numMatch = sStr.match(/([0-9]+(?:[\.,][0-9]+)?)/);
    if (numMatch) {
      return {
        fullName: mName[1].trim(),
        className: mClass ? mClass[1].trim() : 'عام',
        score: parseFloat(numMatch[1].replace(',', '.'))
      };
    }
  }

  // 3. Fallback: JSON format { N, C, S } or { name, class, score }
  try {
    const parsed = JSON.parse(rawText);
    const sVal = parsed.S !== undefined ? parsed.S : (parsed.score !== undefined ? parsed.score : parsed.mark);
    const num = typeof sVal === 'string' ? parseFloat(normalizeDigits(sVal).replace(',', '.')) : parseFloat(sVal);
    if (!isNaN(num)) {
      return {
        fullName: (parsed.N || parsed.name || parsed.fullName || '').trim(),
        className: (parsed.C || parsed.class || parsed.className || 'عام').trim(),
        score: num
      };
    }
  } catch (e) { }

  // 4. Fallback: CSV or Pipe separated format ("أحمد بن علي,1ع1,18/20")
  if (rawText.includes(',') || rawText.includes('|') || rawText.includes(';')) {
    const parts = rawText.split(/[,|;]/).map(s => s.trim());
    if (parts.length >= 3) {
      const numPart = normalizeDigits(parts[2]).replace(',', '.');
      const numMatch = numPart.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (numMatch) {
        return {
          fullName: parts[0],
          className: parts[1] || 'عام',
          score: parseFloat(numMatch[1])
        };
      }
    }
  }

  return null;
}

// Scanner lock state to eliminate rapid duplicate reading
let isScanLocked = false;

// QR Code Parsing & Controlled Confirmation Flow
function handleDecodedData(decodedText) {
  if (isScanLocked) return;

  const studentData = parseStudentQRData(decodedText);

  if (!studentData || !studentData.fullName || isNaN(studentData.score)) {
    showToast('الرمز لا يحتوي على بيانات صالحة (الاسم، القسم، العلامة)', 'warning');
    return;
  }

  // Lock scanning immediately so subsequent frames are completely ignored
  isScanLocked = true;

  // Ensure className fallback
  if (!studentData.className) {
    studentData.className = 'عام';
  }

  // Exact full-name check (e.g., "أحمد بن علي")
  const normNewName = normalizeArabic(studentData.fullName);
  const normNewClass = normalizeArabic(studentData.className);

  const existingIndex = scannedStudents.findIndex(item => {
    const normName = normalizeArabic(item.fullName);
    const normClass = normalizeArabic(item.className);
    return normName === normNewName && normClass === normNewClass;
  });

  if (existingIndex !== -1) {
    const existing = scannedStudents[existingIndex];
    triggerVibrate([160, 70, 160]); // Distinct warning buzz (no audio sound)
    showScanDuplicateModal(existing);
    return;
  }

  // Add new student record
  const newRecord = {
    id: 'std_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    fullName: studentData.fullName,
    className: studentData.className,
    score: studentData.score,
    timestamp: new Date().toLocaleTimeString('ar-DZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date: new Date().toLocaleDateString('ar-DZ')
  };

  scannedStudents.unshift(newRecord);
  saveData();
  triggerVibrate([60, 40, 90]); // Tactile confirmation double-pulse (no audio sound)
  renderUI();
  showScanSuccessModal(newRecord);
}

// Show Pop-up on Scan Success and Pause Scanner
function showScanSuccessModal(record) {
  const nameEl = document.getElementById('success-student-name');
  const classEl = document.getElementById('success-student-class');
  const scoreEl = document.getElementById('success-student-score');
  const laser = document.getElementById('scanner-laser');
  const statusText = document.getElementById('scanner-status-text');

  if (nameEl) nameEl.innerText = record.fullName;
  if (classEl) classEl.innerText = record.className;
  if (scoreEl) {
    scoreEl.innerText = `${record.score} / 20`;
    const isPass = parseFloat(record.score) >= 10;
    scoreEl.className = `scan-pop-badge-score ${isPass ? 'pass' : 'fail'}`;
  }

  // Pause laser line
  if (laser) laser.style.display = 'none';
  if (statusText) statusText.innerText = 'تم المسح بنجاح - اضغط (OK) لمسح التالي';

  // Pause video feed processing to prevent fast duplicate reads
  if (html5QrCode && isScanning) {
    try { html5QrCode.pause(true); } catch (e) { }
  }

  openModal('scanSuccessModal');
}

// Resume scanning when user presses "مسح التالي (OK)"
function resumeScanningAfterSuccess() {
  triggerVibrate(30);
  closeModal('scanSuccessModal');

  const laser = document.getElementById('scanner-laser');
  const statusText = document.getElementById('scanner-status-text');

  if (laser) laser.style.display = 'block';
  if (statusText) statusText.innerText = 'المسح نشط - وجّه نحو الرمز التالي';

  // Resume camera scanning
  if (html5QrCode && isScanning) {
    try { html5QrCode.resume(); } catch (e) { }
  }

  showToast('جاهز لمسح التلميذ التالي', 'info');

  // Grace period debounce (700ms) to ensure phone moved away from previous QR code
  setTimeout(() => {
    isScanLocked = false;
  }, 700);
}

// Show Pop-up on Duplicate Scan and Pause Scanner
function showScanDuplicateModal(student) {
  const nameEl = document.getElementById('dup-student-name');
  const classEl = document.getElementById('dup-student-class');
  const scoreEl = document.getElementById('dup-student-score');
  const laser = document.getElementById('scanner-laser');
  const statusText = document.getElementById('scanner-status-text');

  if (nameEl) nameEl.innerText = student.fullName;
  if (classEl) classEl.innerText = student.className;
  if (scoreEl) scoreEl.innerText = `${student.score} / 20`;

  if (laser) laser.style.display = 'none';
  if (statusText) statusText.innerText = 'التلميذ مسجل مسبقاً - اضغط متابعة للاستئناف';

  if (html5QrCode && isScanning) {
    try { html5QrCode.pause(true); } catch (e) { }
  }

  openModal('scanDuplicateModal');
}

function resumeScanningAfterDuplicate() {
  triggerVibrate(30);
  closeModal('scanDuplicateModal');

  const laser = document.getElementById('scanner-laser');
  const statusText = document.getElementById('scanner-status-text');

  if (laser) laser.style.display = 'block';
  if (statusText) statusText.innerText = 'المسح نشط - وجّه العدسة نحو الرمز';

  if (html5QrCode && isScanning) {
    try { html5QrCode.resume(); } catch (e) { }
  }

  setTimeout(() => {
    isScanLocked = false;
  }, 700);
}

// Camera Scanner & Permission Management
function initScannerFlow() {
  initCameraPermissionFlow();

  // Check if permission was already granted previously
  const previouslyGranted = localStorage.getItem('pwa_cam_permission_granted') === 'true';
  if (previouslyGranted) {
    // Attempt auto-start if already approved
    requestCameraAccess(true);
  } else {
    const promptEl = document.getElementById('camera-permission-prompt');
    if (promptEl) promptEl.style.display = 'flex';
  }
}

function initCameraPermissionFlow() {
  const requestBtn = document.getElementById('btn-request-camera');
  const retryBtn = document.getElementById('btn-retry-camera');
  const toggleCamBtn = document.getElementById('btn-toggle-camera');

  if (requestBtn) {
    requestBtn.addEventListener('click', () => {
      requestCameraAccess(false);
    });
  }

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      requestCameraAccess(false);
    });
  }

  if (toggleCamBtn) {
    toggleCamBtn.addEventListener('click', () => {
      toggleCameraPauseResume();
    });
  }
}

function requestCameraAccess(isAutoStart = false) {
  const promptEl = document.getElementById('camera-permission-prompt');
  const blockedEl = document.getElementById('camera-blocked-notice');
  const statusText = document.getElementById('scanner-status-text');

  if (statusText) statusText.innerText = 'جاري التحقق من إذن الكاميرا...';

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('متصفحك لا يدعم الوصول المباشر للكاميرا', 'warning');
    return;
  }

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(stream => {
      // Permission granted - stop temporary probe stream
      stream.getTracks().forEach(t => t.stop());
      localStorage.setItem('pwa_cam_permission_granted', 'true');

      if (promptEl) promptEl.style.display = 'none';
      if (blockedEl) blockedEl.style.display = 'none';

      initScanner();
    })
    .catch(err => {
      console.warn('Camera permission denied or error:', err);
      if (!isAutoStart) {
        if (promptEl) promptEl.style.display = 'none';
        if (blockedEl) blockedEl.style.display = 'flex';
        if (statusText) statusText.innerText = 'تم حظر إذن الكاميرا';
        showToast('يرجى تفعيل صلاحية الكاميرا من إعدادات المتصفح', 'warning');
      } else {
        // If auto-start failed, show the initial friendly prompt
        if (promptEl) promptEl.style.display = 'flex';
        if (statusText) statusText.innerText = 'الكاميرا بانتظار إذن التشغيل';
      }
    });
}

function initScanner() {
  if (typeof Html5Qrcode === 'undefined') {
    console.warn('Html5Qrcode not loaded yet.');
    return;
  }

  if (!html5QrCode) {
    html5QrCode = new Html5Qrcode("reader");
  }

  Html5Qrcode.getCameras().then(cameras => {
    if (cameras && cameras.length) {
      availableCameras = cameras;
      // Prefer back camera (environment)
      const backCam = cameras.find(c => /back|rear|environment/i.test(c.label)) || cameras[cameras.length - 1];
      currentCameraId = backCam.id;
      startScanning(currentCameraId);
    } else {
      console.warn('No cameras found.');
      showToast('لم يتم العثور على كاميرا في هذا الجهاز', 'warning');
    }
  }).catch(err => {
    console.warn('Camera detection error:', err);
  });
}

function startScanning(cameraId) {
  if (!html5QrCode || isScanning) return;

  const config = {
    fps: 15,
    qrbox: { width: 220, height: 220 },
    aspectRatio: 1.0
  };

  html5QrCode.start(
    cameraId,
    config,
    (decodedText) => {
      handleDecodedData(decodedText);
    },
    (errorMessage) => {
      // Routine scan frame misses
    }
  ).then(() => {
    isScanning = true;
    const laser = document.getElementById('scanner-laser');
    if (laser) laser.style.display = 'block';

    const statusText = document.getElementById('scanner-status-text');
    if (statusText) statusText.innerText = 'المسح نشط - وجّه العدسة نحو الرمز';

    updateCameraToggleIcon(true);
  }).catch(err => {
    console.warn('Unable to start camera:', err);
    isScanning = false;
  });
}

function toggleCameraPauseResume() {
  const statusText = document.getElementById('scanner-status-text');
  const laser = document.getElementById('scanner-laser');

  if (isScanning && html5QrCode) {
    html5QrCode.stop().then(() => {
      isScanning = false;
      if (laser) laser.style.display = 'none';
      if (statusText) statusText.innerText = 'الكاميرا متوقفة مؤقتاً';
      updateCameraToggleIcon(false);
      showToast('تم إيقاف الكاميرا مؤقتاً', 'warning');
    }).catch(console.error);
  } else if (!isScanning) {
    if (currentCameraId) {
      startScanning(currentCameraId);
      showToast('تم استئناف تشغيل الكاميرا ', 'success');
    } else {
      requestCameraAccess(false);
    }
  }
}

function updateCameraToggleIcon(active) {
  const icon = document.getElementById('icon-cam-toggle');
  if (!icon) return;
  if (active) {
    // Show pause/stop video icon
    icon.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="9" y2="15"></line><line x1="15" y1="9" x2="15" y2="15"></line>';
  } else {
    // Show camera start icon
    icon.innerHTML = '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle>';
  }
}

function switchCamera() {
  if (!html5QrCode || availableCameras.length <= 1) {
    showToast('لا توجد كاميرا إضافية للتبديل إليها', 'warning');
    return;
  }

  const currentIndex = availableCameras.findIndex(c => c.id === currentCameraId);
  const nextIndex = (currentIndex + 1) % availableCameras.length;
  currentCameraId = availableCameras[nextIndex].id;

  if (isScanning) {
    html5QrCode.stop().then(() => {
      isScanning = false;
      startScanning(currentCameraId);
      showToast('تم تبديل الكاميرا', 'info');
    }).catch(console.error);
  } else {
    showToast('تم اختيار الكاميرا البديلة', 'info');
  }
}

function toggleTorch() {
  const torchBtn = document.getElementById('btn-torch');
  if (!html5QrCode || !isScanning) {
    showToast('يجب تشغيل الكاميرا أولاً لاستخدام الفلاش', 'warning');
    return;
  }

  try {
    const video = document.querySelector('#reader video');
    if (!video || !video.srcObject) return;

    const track = video.srcObject.getVideoTracks()[0];
    const capabilities = track.getCapabilities ? track.getCapabilities() : {};

    if (!capabilities.torch) {
      showToast('الفلاش غير مدعوم على هذه الكاميرا', 'warning');
      return;
    }

    isTorchOn = !isTorchOn;
    track.applyConstraints({
      advanced: [{ torch: isTorchOn }]
    }).then(() => {
      if (torchBtn) {
        torchBtn.classList.toggle('active', isTorchOn);
      }
      showToast(isTorchOn ? 'تم تشغيل الفلاش 💡' : 'تم إيقاف الفلاش', 'info');
    }).catch(err => {
      showToast('تعذر تغيير حالة الفلاش', 'warning');
    });
  } catch (e) {
    console.warn('Torch toggle error:', e);
  }
}

// Render UI Components
function renderUI() {
  renderClassFilter();
  renderStats();
  renderTable();
}

function renderClassFilter() {
  const container = document.getElementById('class-filters');
  if (!container) return;

  // Extract unique classes
  const classes = Array.from(new Set(scannedStudents.map(s => s.className).filter(Boolean)));

  let html = `<button class="class-pill ${activeClassFilter === 'ALL' ? 'active' : ''}" data-class="ALL">جميع الأقسام (${scannedStudents.length})</button>`;

  classes.forEach(cls => {
    const count = scannedStudents.filter(s => s.className === cls).length;
    html += `<button class="class-pill ${activeClassFilter === cls ? 'active' : ''}" data-class="${cls}">${cls} (${count})</button>`;
  });

  container.innerHTML = html;

  // Add click listeners
  container.querySelectorAll('.class-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      activeClassFilter = btn.getAttribute('data-class');
      renderUI();
    });
  });
}

function renderStats() {
  const countEl = document.getElementById('stat-total');
  const avgEl = document.getElementById('stat-avg');
  const maxEl = document.getElementById('stat-max');
  const passEl = document.getElementById('stat-pass');

  const filtered = activeClassFilter === 'ALL'
    ? scannedStudents
    : scannedStudents.filter(s => s.className === activeClassFilter);

  if (filtered.length === 0) {
    if (countEl) countEl.innerText = '0';
    if (avgEl) avgEl.innerText = '--';
    if (maxEl) maxEl.innerText = '--';
    if (passEl) passEl.innerText = '0%';
    return;
  }

  const scores = filtered.map(s => s.score);
  const total = scores.length;
  const sum = scores.reduce((acc, curr) => acc + curr, 0);
  const avg = (sum / total).toFixed(2);
  const max = Math.max(...scores);
  const passCount = scores.filter(s => s >= 10).length;
  const passRate = Math.round((passCount / total) * 100);

  if (countEl) countEl.innerText = total;
  if (avgEl) avgEl.innerText = avg;
  if (maxEl) maxEl.innerText = max;
  if (passEl) passEl.innerText = `${passRate}%`;
}

function renderTable() {
  const tbody = document.getElementById('table-results-body');
  const emptyState = document.getElementById('table-empty-state');
  const searchInput = document.getElementById('search-input');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  let list = activeClassFilter === 'ALL'
    ? scannedStudents
    : scannedStudents.filter(s => s.className === activeClassFilter);

  if (query) {
    list = list.filter(s =>
      (s.fullName || '').toLowerCase().includes(query) ||
      (s.className || '').toLowerCase().includes(query)
    );
  }

  const sortedList = getSortedStudents(list);

  if (sortedList.length === 0) {
    if (tbody) tbody.innerHTML = '';
    if (emptyState) emptyState.style.display = 'block';
    return;
  }

  if (emptyState) emptyState.style.display = 'none';

  let html = '';
  sortedList.forEach((std, index) => {
    const isPass = std.score >= 10;
    const badgeClass = isPass ? 'badge-score-pass' : 'badge-score-fail';
    const statusText = isPass ? 'ناجح' : 'مستدرك';

    html += `
      <tr>
        <td style="color: var(--text-muted); font-weight: bold; width: 34px;">${index + 1}</td>
        <td>
          <div class="student-name-cell">
            ${escapeHtml(std.fullName)}
          </div>
          <span class="student-time-sub">${std.timestamp}</span>
        </td>
        <td><span class="class-badge">${escapeHtml(std.className)}</span></td>
        <td>
          <span class="badge-score ${badgeClass}" title="${statusText}">
            ${std.score}
          </span>
        </td>
        <td style="width: 40px; text-align: center;">
          <button class="btn-delete-row" data-id="${std.id}" title="حذف السطر">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </td>
      </tr>
    `;
  });

  if (tbody) {
    tbody.innerHTML = html;

    // Attach row delete handlers
    tbody.querySelectorAll('.btn-delete-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = btn.getAttribute('data-id');
        deleteStudent(id);
      });
    });
  }
}

function deleteStudent(id) {
  const item = scannedStudents.find(s => s.id === id);
  if (!item) return;

  showCustomConfirm({
    title: 'حذف نقطة التلميذ',
    message: `هل تريد بالتأكيد حذف نقطة التلميذ (${item.fullName}) من القائمة؟`,
    iconType: 'danger',
    confirmText: 'نعم، حذف',
    cancelText: 'إلغاء',
    onConfirm: () => {
      scannedStudents = scannedStudents.filter(s => s.id !== id);
      saveData();
      renderUI();
      showToast(`تم حذف نقطة ${item.fullName}`, 'info');
    }
  });
}

function clearAllStudents() {
  if (scannedStudents.length === 0) {
    showToast('الجدول فارغ بالفعل - لا توجد بيانات لمسحها', 'warning');
    return;
  }

  showCustomConfirm({
    title: 'مسح جميع النتائج',
    message: 'هل أنت متأكد من مسح جميع النقاط المسجلة في التطبيق؟ لا يمكن التراجع عن هذا الإجراء.',
    iconType: 'danger',
    confirmText: 'مسح الكل',
    cancelText: 'تراجع',
    onConfirm: () => {
      scannedStudents = [];
      saveData();
      renderUI();
      showToast('تم مسح جميع النقاط بنجاح', 'info');
    }
  });
}

// Export to CSV with Arabic UTF-8 BOM (Sorted alphabetically by Full Name: أ -> ي)
function exportCSV() {
  if (scannedStudents.length === 0) {
    showToast('لا توجد بيانات أو نتائج لتصديرها بعد', 'warning');
    return;
  }

  const rawList = activeClassFilter === 'ALL'
    ? scannedStudents
    : scannedStudents.filter(s => s.className === activeClassFilter);

  const list = getExportSortedStudents(rawList);

  let csv = '\uFEFFالرقم,الاسم واللقب,القسم,العلامة / 20,الحالة,وقت التسجيل,تاريخ المسح\n';

  list.forEach((s, idx) => {
    const status = s.score >= 10 ? 'ناجح' : 'مستدرك';
    csv += `"${idx + 1}","${s.fullName}","${s.className}","${s.score}","${status}","${s.timestamp}","${s.date}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const filterLabel = activeClassFilter === 'ALL' ? 'جميع_الأقسام' : activeClassFilter;
  a.href = url;
  a.download = `نتائج_الفرض_${filterLabel}_${formatDateForFilename()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('تم تحميل ملف CSV بنجاح', 'success');
}

// Export to XLSX (Excel) with a separate Sheet for each class (Sorted alphabetically: أ -> ي)
function exportXLSX() {
  if (typeof XLSX === 'undefined') {
    showToast('مكتبة Excel غير جاهزة', 'warning');
    return;
  }

  if (scannedStudents.length === 0) {
    showToast('لا توجد بيانات أو نتائج لتصديرها بعد', 'warning');
    return;
  }

  const wb = XLSX.utils.book_new();

  // Helper to create sheet data
  function buildSheetData(studentsList) {
    const rows = [
      ['الرقم', 'الاسم واللقب', 'القسم', 'العلامة / 20', 'التقدير', 'وقت التسجيل']
    ];

    // Order results by full name Ascending Order (ترتيب تصاعدي أ -> ي)
    const sorted = getExportSortedStudents(studentsList);
    sorted.forEach((s, idx) => {
      const status = s.score >= 10 ? 'ناجح' : 'مستدرك';
      rows.push([idx + 1, s.fullName, s.className, s.score, status, s.timestamp]);
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    // Enable RTL orientation for the sheet
    if (!ws['!views']) ws['!views'] = [];
    ws['!views'].push({ rightToLeft: true });

    // Column widths
    ws['!cols'] = [
      { wch: 8 },  // الرقم
      { wch: 30 }, // الاسم واللقب
      { wch: 14 }, // القسم
      { wch: 14 }, // العلامة
      { wch: 12 }, // التقدير
      { wch: 16 }  // الوقت
    ];

    return ws;
  }

  // Each Class in its own separated Sheet (Strictly one class per sheet)
  const classes = Array.from(new Set(scannedStudents.map(s => (s.className || 'عام').trim()).filter(Boolean)));

  if (classes.length === 0) {
    classes.push('القسم');
  }

  // Sort class names alphabetically for clean organization
  classes.sort((a, b) => a.localeCompare(b, 'ar'));

  classes.forEach(cls => {
    const classStudents = scannedStudents.filter(s => ((s.className || 'عام').trim()) === cls);
    if (classStudents.length > 0) {
      const classWs = buildSheetData(classStudents);
      // Sanitize sheet name: max 31 chars, no special characters: \ / ? * : [ ]
      let cleanName = cls.replace(/[\\\/\?\*\:\[\]]/g, '_').substring(0, 30) || 'قسم';
      XLSX.utils.book_append_sheet(wb, classWs, cleanName);
    }
  });

  const filename = `نقاط_الفروض_الأقسام_${formatDateForFilename()}.xlsx`;
  XLSX.writeFile(wb, filename);
  showToast('تم تصدير ملف Excel بنجاح', 'success');
}

function formatDateForFilename() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


// Event Listeners Setup
function setupEventListeners() {
  // Search input
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderTable();
    });
  }

  // Camera Switch
  const switchCamBtn = document.getElementById('btn-switch-cam');
  if (switchCamBtn) {
    switchCamBtn.addEventListener('click', switchCamera);
  }

  // Torch Toggle
  const torchBtn = document.getElementById('btn-torch');
  if (torchBtn) {
    torchBtn.addEventListener('click', toggleTorch);
  }

  // Export buttons
  const exportCsvBtn = document.getElementById('btn-export-csv');
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', exportCSV);
  }

  const exportXlsxBtn = document.getElementById('btn-export-xlsx');
  if (exportXlsxBtn) {
    exportXlsxBtn.addEventListener('click', exportXLSX);
  }

  // Clear all button
  const clearBtn = document.getElementById('btn-clear-all');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearAllStudents);
  }

  // Manual Add Modal Form
  const manualForm = document.getElementById('manual-add-form');
  if (manualForm) {
    manualForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('manual-name').value;
      const cls = document.getElementById('manual-class').value;
      const score = document.getElementById('manual-score').value;

      if (!name || isNaN(score)) return;

      const formattedData = `الاسم الكامل: ${name.trim()}\nالقسم : ${(cls || 'عام').trim()}\nالعلامة: ${score}/20`;
      handleDecodedData(formattedData);

      manualForm.reset();
      closeModal('manualAddModal');
    });
  }

  // Vanilla Modal Triggers (No external bootstrap.js required)
  document.querySelectorAll('[data-bs-toggle="modal"]').forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      const target = trigger.getAttribute('data-bs-target');
      if (target) {
        const modalId = target.replace('#', '');
        openModal(modalId);
      }
    });
  });

  document.querySelectorAll('[data-bs-dismiss="modal"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.modal');
      if (modal) {
        closeModal(modal.id);
      }
    });
  });

  // Scan Success Modal "OK / Next" button
  const scanNextBtn = document.getElementById('btn-scan-next');
  if (scanNextBtn) {
    scanNextBtn.addEventListener('click', () => {
      resumeScanningAfterSuccess();
    });
  }

  // Duplicate Scan Modal "OK / Resume" button
  const dupResumeBtn = document.getElementById('btn-dup-resume');
  if (dupResumeBtn) {
    dupResumeBtn.addEventListener('click', () => {
      resumeScanningAfterDuplicate();
    });
  }

  // Keyboard shortcut: Enter or Space to quickly confirm pop-up and scan next
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const successModal = document.getElementById('scanSuccessModal');
      if (successModal && successModal.classList.contains('show')) {
        e.preventDefault();
        resumeScanningAfterSuccess();
        return;
      }
      const dupModal = document.getElementById('scanDuplicateModal');
      if (dupModal && dupModal.classList.contains('show')) {
        e.preventDefault();
        resumeScanningAfterDuplicate();
        return;
      }
    }
  });
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.style.display = 'block';
  modal.classList.add('show');
  modal.removeAttribute('aria-hidden');
  document.body.classList.add('modal-open');

  let backdrop = document.querySelector('.modal-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop fade show';
    backdrop.addEventListener('click', () => closeModal(modalId));
    document.body.appendChild(backdrop);
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('modal-open');
  const backdrop = document.querySelector('.modal-backdrop');
  if (backdrop) backdrop.remove();

  // If scan pop-up was closed via backdrop, ensure camera resumes
  if (modalId === 'scanSuccessModal' || modalId === 'scanDuplicateModal') {
    const laser = document.getElementById('scanner-laser');
    if (laser) laser.style.display = 'block';
    if (html5QrCode && isScanning) {
      try { html5QrCode.resume(); } catch (e) { }
    }
    setTimeout(() => {
      isScanLocked = false;
    }, 600);
  }
}

// Styled Custom Dialog Pop-up Handler
let customDialogCallback = null;

function showCustomConfirm({ title, message, iconType = 'danger', confirmText = 'تأكيد', cancelText = 'إلغاء', onConfirm }) {
  const modal = document.getElementById('appCustomDialog');
  if (!modal) {
    if (confirm(message)) onConfirm();
    return;
  }

  const titleEl = document.getElementById('custom-dialog-title');
  const msgEl = document.getElementById('custom-dialog-message');
  const iconWrap = document.getElementById('custom-dialog-icon-wrap');
  const iconEl = document.getElementById('custom-dialog-icon');
  const confirmBtn = document.getElementById('custom-dialog-confirm-btn');
  const cancelBtn = document.getElementById('custom-dialog-cancel-btn');

  if (titleEl) titleEl.innerText = title;
  if (msgEl) msgEl.innerText = message;
  if (confirmBtn) {
    confirmBtn.innerText = confirmText;
    confirmBtn.className = iconType === 'danger' ? 'btn btn-dialog-action' : 'btn btn-dialog-action primary';
  }
  if (cancelBtn) cancelBtn.innerText = cancelText;

  if (iconWrap && iconEl) {
    iconWrap.className = `custom-dialog-icon-wrap ${iconType}`;
    if (iconType === 'danger') {
      iconEl.innerHTML = '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>';
    } else {
      iconEl.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
    }
  }

  customDialogCallback = onConfirm;
  openModal('appCustomDialog');
}

// Dialog buttons binding
document.addEventListener('DOMContentLoaded', () => {
  const confirmBtn = document.getElementById('custom-dialog-confirm-btn');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => {
      closeModal('appCustomDialog');
      if (typeof customDialogCallback === 'function') {
        const cb = customDialogCallback;
        customDialogCallback = null;
        cb();
      }
    });
  }

  const cancelBtn = document.getElementById('custom-dialog-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      closeModal('appCustomDialog');
      customDialogCallback = null;
    });
  }
});

