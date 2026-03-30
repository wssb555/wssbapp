import WebSocket from 'ws';
import http from 'http';

function getPages() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

let _id = 1;
function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = _id++;
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeListener('message', handler); reject(new Error('timeout')); }, 30000);
  });
}

async function evaluate(ws, expr, awaitPromise = false) {
  const r = await cdpSend(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const pages = await getPages();
  console.log('=== ALL PAGES ===');
  pages.forEach((p, i) => console.log(`  [${i}] ${p.title} | ${p.url}`));

  const target = pages.find(p => p.url?.includes('hbgbzx.gov.cn'));
  if (!target) { console.log('No target page'); return; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await cdpSend(ws, 'Runtime.enable');

  // 1. Check if extension scripts are running
  console.log('\n=== EXTENSION DIAGNOSTICS ===');
  
  // Check for stealth.js markers via property descriptors
  const stealthCheck = await evaluate(ws, `
    (function() {
      var desc = Object.getOwnPropertyDescriptor(document, 'visibilityState');
      var descH = Object.getOwnPropertyDescriptor(document, 'hidden');
      return JSON.stringify({
        visibilityStateOverridden: desc ? (typeof desc.get === 'function') : false,
        hiddenOverridden: descH ? (typeof descH.get === 'function') : false,
        actualHidden: document.hidden,
        actualVisState: document.visibilityState,
        webdriver: navigator.webdriver,
        // Check if content.js set up passive mode
        hasHbgbzxSetup: !!document.querySelector('video')?._hbgbzxSetup
      });
    })()
  `);
  console.log('Stealth check:', stealthCheck);

  // 2. Check login status
  console.log('\n=== LOGIN STATUS ===');
  const loginCheck = await evaluate(ws, `
    (function() {
      // Check cookies for session
      var cookies = document.cookie;
      // Check localStorage for tokens
      var token = localStorage.getItem('token') || localStorage.getItem('access_token') || localStorage.getItem('Authorization');
      // Check for login-related elements
      var loginBtn = document.querySelector('[class*="login"], [class*="Login"]');
      var userName = document.querySelector('[class*="username"], [class*="user_name"], [class*="avatar"]');
      return JSON.stringify({
        hasCookies: cookies.length > 10,
        cookiePreview: cookies.substring(0, 200),
        hasToken: !!token,
        tokenPreview: token ? token.substring(0, 50) : null,
        hasLoginBtn: !!loginBtn,
        hasUserName: !!userName,
        userNameText: userName ? userName.textContent.trim().substring(0, 50) : null
      });
    })()
  `);
  console.log('Login:', loginCheck);

  // 3. Try navigating to my_course to verify login, then click a course
  console.log('\n=== NAVIGATE TO MY_COURSE ===');
  await evaluate(ws, `location.hash = '#/study_center/my_course'`);
  await sleep(4000);

  const courseCheck = await evaluate(ws, `
    (function() {
      var items = document.querySelectorAll('li.course_list');
      if (items.length === 0) return JSON.stringify({ loggedIn: false, count: 0 });
      // Get first unfinished course details
      var first = null;
      items.forEach(function(item) {
        if (first) return;
        var titleEl = item.querySelector('.course_list_right_title');
        var progressEl = item.querySelector('.el-progress__text');
        var saveBtn = item.querySelector('.Save');
        var progress = parseInt(progressEl ? progressEl.textContent.trim() : '100', 10);
        if (progress < 100 && saveBtn) {
          first = {
            title: titleEl ? titleEl.textContent.trim() : '',
            progress: progress,
            btnText: saveBtn.textContent.trim()
          };
        }
      });
      return JSON.stringify({ loggedIn: true, count: items.length, firstUnfinished: first });
    })()
  `);
  console.log('Courses:', courseCheck);

  const data = JSON.parse(courseCheck);
  if (data.loggedIn && data.firstUnfinished) {
    // Click the first unfinished course to get to video page
    console.log('\n=== CLICKING FIRST COURSE ===');
    console.log(`Course: "${data.firstUnfinished.title}"`);
    
    await evaluate(ws, `
      (function() {
        var items = document.querySelectorAll('li.course_list');
        for (var i = 0; i < items.length; i++) {
          var btn = items[i].querySelector('.Save');
          if (btn && btn.textContent.trim() === '开始学习') {
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return 'clicked';
          }
        }
        return 'not_found';
      })()
    `);

    // Wait for navigation
    await sleep(6000);

    const newUrl = await evaluate(ws, 'location.hash');
    console.log('After click, hash:', newUrl);

    // Check for video
    const videoCheck = await evaluate(ws, `
      (function() {
        var v = document.querySelector('video');
        var menus = document.querySelectorAll('.menu_item');
        return JSON.stringify({
          hasVideo: !!v,
          videoRate: v ? v.playbackRate : null,
          videoPaused: v ? v.paused : null,
          sectionCount: menus.length,
          currentUrl: location.hash
        });
      })()
    `);
    console.log('Video page:', videoCheck);

    // Recheck stealth.js now on video page
    const stealthRecheck = await evaluate(ws, `
      (function() {
        var desc = Object.getOwnPropertyDescriptor(document, 'visibilityState');
        return JSON.stringify({
          overridden: desc ? (typeof desc.get === 'function') : false,
          hidden: document.hidden,
          visState: document.visibilityState
        });
      })()
    `);
    console.log('Stealth recheck:', stealthRecheck);
  }

  // 4. Check service worker (extension background)
  console.log('\n=== EXTENSION SERVICE WORKER ===');
  try {
    const targets = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:9222/json/list', res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    const sw = targets.filter(t => t.type === 'service_worker' || t.url?.includes('chrome-extension'));
    console.log('Extension targets:', JSON.stringify(sw.map(s => ({ type: s.type, title: s.title, url: s.url })), null, 2));
  } catch (e) {
    console.log('Error fetching targets:', e.message);
  }

  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
