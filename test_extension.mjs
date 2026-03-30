// ============================================================
// Extension Integration Test Suite
// Tests: stealth, video speed, course scraping, section switch
// ============================================================
import WebSocket from 'ws';
import http from 'http';

// --- CDP Helpers ---
function getPages() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function connectPage(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
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
    setTimeout(() => { ws.removeListener('message', handler); reject(new Error('CDP timeout')); }, 30000);
  });
}

async function evaluate(ws, expr, awaitPromise = false) {
  const r = await cdpSend(ws, 'Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Test Results ---
const results = [];
function pass(name, detail) { results.push({ name, status: 'PASS', detail }); console.log(`  ✅ PASS: ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`  ❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
function info(msg) { console.log(`  ℹ️  ${msg}`); }

// ============================================================
// TEST 1: Stealth — Visibility API override
// ============================================================
async function testStealth(ws) {
  console.log('\n========== TEST 1: Stealth (Visibility API) ==========');

  const hidden = await evaluate(ws, 'document.hidden');
  if (hidden === false) pass('document.hidden = false');
  else fail('document.hidden should be false', `got: ${hidden}`);

  const state = await evaluate(ws, 'document.visibilityState');
  if (state === 'visible') pass('document.visibilityState = "visible"');
  else fail('document.visibilityState should be "visible"', `got: ${state}`);

  const webdriver = await evaluate(ws, 'navigator.webdriver');
  if (webdriver === false) pass('navigator.webdriver = false');
  else fail('navigator.webdriver should be false', `got: ${webdriver}`);

  // Check no CDP markers
  const markers = await evaluate(ws, `
    JSON.stringify({
      cdc: typeof window.cdc_adoQpoasnfa76pfcZLmcfl_Array,
      selenium: typeof window.__selenium_evaluate,
      domAuto: typeof window.domAutomation
    })
  `);
  const m = JSON.parse(markers);
  if (m.cdc === 'undefined' && m.selenium === 'undefined' && m.domAuto === 'undefined')
    pass('No automation markers found');
  else fail('Automation markers present', markers);
}

// ============================================================
// TEST 2: Video Speed Setting
// ============================================================
async function testVideoSpeed(ws) {
  console.log('\n========== TEST 2: Video Speed ==========');

  // Check if a video element exists
  const hasVideo = await evaluate(ws, '!!document.querySelector("video")');
  if (!hasVideo) {
    info('No video on current page, navigating to video page...');
    await evaluate(ws, `location.hash = '#/video_detail?id=5574&typeInfo=2'`);
    await sleep(5000);
  }

  // Wait for video
  let videoReady = false;
  for (let i = 0; i < 10; i++) {
    videoReady = await evaluate(ws, '!!document.querySelector("video")');
    if (videoReady) break;
    await sleep(1000);
  }

  if (!videoReady) { fail('Video element not found after 10s'); return; }
  pass('Video element found');

  // Check current playback rate
  const rate = await evaluate(ws, 'document.querySelector("video").playbackRate');
  info(`Current playback rate: ${rate}x`);

  if (rate === 1.5) {
    pass('Playback rate is 1.5x (extension working)');
  } else {
    info(`Rate is ${rate}x, not 1.5x. Waiting 3s for content.js to apply...`);
    await sleep(3000);
    const rate2 = await evaluate(ws, 'document.querySelector("video").playbackRate');
    if (rate2 === 1.5) pass('Playback rate became 1.5x after delay');
    else fail('Playback rate not 1.5x', `got: ${rate2}x`);
  }

  // Test speed persistence: manually reset and check re-application
  info('Testing speed persistence: resetting to 1x...');
  await evaluate(ws, 'document.querySelector("video").playbackRate = 1.0');
  await sleep(1000);
  const rateAfterReset = await evaluate(ws, 'document.querySelector("video").playbackRate');
  if (rateAfterReset === 1.5) pass('Speed re-applied after manual reset (ratechange guard works)');
  else fail('Speed not re-applied after reset', `still ${rateAfterReset}x`);

  // Test video playing state
  const videoState = await evaluate(ws, `
    (function() {
      var v = document.querySelector('video');
      return JSON.stringify({
        paused: v.paused,
        ended: v.ended,
        duration: v.duration,
        currentTime: v.currentTime,
        readyState: v.readyState,
        rate: v.playbackRate
      });
    })()
  `);
  info('Video state: ' + videoState);
}

// ============================================================
// TEST 3: Course Scraping
// ============================================================
async function testCourseScraping(ws) {
  console.log('\n========== TEST 3: Course Scraping ==========');

  info('Navigating to my_course page...');
  await evaluate(ws, `location.hash = '#/study_center/my_course'`);
  await sleep(4000);

  // Check if course list loaded
  const courseCount = await evaluate(ws, 'document.querySelectorAll("li.course_list").length');
  info(`Found ${courseCount} course items on page`);

  if (courseCount > 0) {
    pass('Course list loaded');

    // Test the scrape function by simulating what content.js does
    const scrapeResult = await evaluate(ws, `
      (function() {
        var result = { courses: [], totalCount: 0 };
        var totalEl = document.querySelector('.el-pagination__total');
        if (totalEl) {
          var m = totalEl.textContent.match(/(\\d+)/);
          if (m) result.totalCount = parseInt(m[1], 10);
        }
        var items = document.querySelectorAll('li.course_list');
        items.forEach(function(item, index) {
          var titleEl = item.querySelector('.course_list_right_title');
          var progressEl = item.querySelector('.el-progress__text');
          var saveBtn = item.querySelector('.Save');
          var title = titleEl ? titleEl.textContent.trim() : '';
          var progressText = progressEl ? progressEl.textContent.trim() : '0%';
          var progress = parseInt(progressText, 10) || 0;
          if (progress < 100 && saveBtn && title) {
            result.courses.push({ title: title, progress: progress, pageIndex: index });
          }
        });
        return JSON.stringify(result);
      })()
    `);
    const data = JSON.parse(scrapeResult);
    info(`Total courses: ${data.totalCount}, unfinished on this page: ${data.courses.length}`);
    data.courses.forEach((c, i) => {
      info(`  [${i}] "${c.title}" — ${c.progress}%`);
    });

    if (data.courses.length > 0) pass(`Found ${data.courses.length} unfinished courses`);
    else info('All courses on this page are 100% complete');
  } else {
    // Fallback selectors
    const altCount = await evaluate(ws, `
      document.querySelectorAll('[class*="course_item"], [class*="courseItem"], .el-card').length
    `);
    if (altCount > 0) {
      info(`Found ${altCount} items via fallback selectors`);
      pass('Course items found via fallback selectors');
    } else {
      fail('No course items found with any selector');
    }
  }
}

// ============================================================
// TEST 4: Content Script Communication
// ============================================================
async function testContentScriptComm(ws) {
  console.log('\n========== TEST 4: Content Script Message Handler ==========');

  // Check if content script is loaded by looking for its message handler
  // We'll test via chrome.runtime.sendMessage from the page context
  // But content script runs in isolated world — we need to test differently

  // Check if extension injected stealth.js successfully
  const stealthCheck = await evaluate(ws, `
    (function() {
      // stealth.js should have overridden visibilityState getter
      var desc = Object.getOwnPropertyDescriptor(document, 'visibilityState');
      return desc && typeof desc.get === 'function' ? 'injected' : 'not_found';
    })()
  `);

  if (stealthCheck === 'injected') pass('stealth.js property descriptors detected in MAIN world');
  else fail('stealth.js override not detected', stealthCheck);
}

// ============================================================
// TEST 5: Video Section Detection
// ============================================================
async function testSectionDetection(ws) {
  console.log('\n========== TEST 5: Video Section Detection ==========');

  info('Navigating to video detail page...');
  await evaluate(ws, `location.hash = '#/video_detail?id=5574&typeInfo=2'`);
  await sleep(5000);

  const sectionData = await evaluate(ws, `
    (function() {
      var menuItems = document.querySelectorAll('.menu_item');
      if (menuItems.length === 0) return JSON.stringify({ found: false, count: 0, selectors: 'menu_item' });

      var sections = [];
      menuItems.forEach(function(el, i) {
        sections.push({
          text: el.textContent.trim().substring(0, 60),
          isActive: el.classList.contains('currentChapter'),
          index: i
        });
      });
      return JSON.stringify({ found: true, count: sections.length, sections: sections });
    })()
  `);

  const sd = JSON.parse(sectionData);
  if (sd.found) {
    pass(`Found ${sd.count} video sections`);
    sd.sections.forEach((s, i) => {
      info(`  [${i}] ${s.isActive ? '▶ ' : '  '}${s.text}`);
    });

    const activeIdx = sd.sections.findIndex(s => s.isActive);
    if (activeIdx >= 0) pass(`Current active section: [${activeIdx}] ${sd.sections[activeIdx].text}`);
    else info('No section marked as currentChapter');
  } else {
    fail('No .menu_item sections found');
    // Try fallbacks
    const fallback = await evaluate(ws, `
      document.querySelectorAll('[class*="catalog"] li, [class*="chapter_item"], [class*="sco_item"]').length
    `);
    info(`Fallback selectors found: ${fallback} items`);
  }
}

// ============================================================
// TEST 6: Visibility Override Under Minimize Simulation
// ============================================================
async function testMinimizeSimulation(ws) {
  console.log('\n========== TEST 6: Minimize Simulation ==========');

  // Simulate what happens when the browser fires visibilitychange
  // Our stealth.js should suppress it
  info('Dispatching fake visibilitychange event...');
  const beforeState = await evaluate(ws, 'document.visibilityState');
  await evaluate(ws, `document.dispatchEvent(new Event('visibilitychange'))`);
  await sleep(500);
  const afterState = await evaluate(ws, 'document.visibilityState');

  if (afterState === 'visible') pass('visibilityState remains "visible" after event dispatch');
  else fail('visibilityState changed', `was ${beforeState}, now ${afterState}`);

  // Check video still playing after visibility event
  const videoPlaying = await evaluate(ws, `
    (function() {
      var v = document.querySelector('video');
      if (!v) return 'no_video';
      return v.paused ? 'paused' : 'playing';
    })()
  `);
  info(`Video state after visibility event: ${videoPlaying}`);
  if (videoPlaying === 'playing') pass('Video still playing after visibility change');
  else if (videoPlaying === 'no_video') info('No video on current page (not on video detail page)');
  else info(`Video is ${videoPlaying} (may need manual play first)`);
}

// ============================================================
// TEST 7: Speed Display Sync (CKPlayer UI)
// ============================================================
async function testSpeedDisplaySync(ws) {
  console.log('\n========== TEST 7: Speed Display Sync ==========');

  const speedLabel = await evaluate(ws, `
    (function() {
      var label = document.querySelector('[class*="playbackrate"]');
      return label ? label.textContent.trim() : null;
    })()
  `);

  if (speedLabel) {
    info(`CKPlayer speed label shows: "${speedLabel}"`);
    if (speedLabel.includes('1.5')) pass('Speed display shows 1.5X');
    else info(`Speed display shows "${speedLabel}" (may be different format)`);
  } else {
    info('No CKPlayer speed label found (player may use different UI)');
  }
}

// ============================================================
// TEST 8: Progress Reporting Integrity
// ============================================================
async function testProgressReporting(ws) {
  console.log('\n========== TEST 8: Progress Reporting Integrity ==========');

  // Monitor XHR requests for 10 seconds to verify progress reporting still works
  info('Monitoring network requests for 10s...');
  const requests = await evaluate(ws, `
    new Promise(function(resolve) {
      var reqs = [];
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function(method, url) {
        this._testUrl = url;
        this._testMethod = method;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function(body) {
        reqs.push({
          m: this._testMethod,
          u: (this._testUrl || '').substring(0, 200),
          b: body ? String(body).substring(0, 300) : null
        });
        return origSend.apply(this, arguments);
      };

      setTimeout(function() {
        XMLHttpRequest.prototype.open = origOpen;
        XMLHttpRequest.prototype.send = origSend;
        resolve(JSON.stringify(reqs));
      }, 10000);
    })
  `, true);

  const reqs = JSON.parse(requests);
  info(`Captured ${reqs.length} requests in 10s`);

  const keepAlive = reqs.filter(r => r.u.includes('keep_live'));
  const progress = reqs.filter(r => r.u.includes('user_course'));

  if (keepAlive.length > 0) pass(`Keep-alive heartbeat running (${keepAlive.length} requests)`);
  else info('No keep-alive requests (may not fire in 10s)');

  if (progress.length > 0) {
    pass(`Progress reporting active (${progress.length} reports)`);
    progress.forEach(r => info(`  POST ${r.u} — ${r.b?.substring(0, 100)}`));
  } else {
    info('No progress reports captured in 10s (may need video playing)');
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('🔍 Extension Integration Test Suite');
  console.log('====================================\n');

  // Find the target page
  const pages = await getPages();
  const targetPage = pages.find(p => p.url?.includes('hbgbzx.gov.cn'));
  if (!targetPage) {
    console.error('❌ No hbgbzx.gov.cn page found! Please open the site first.');
    process.exit(1);
  }
  info(`Target page: ${targetPage.url}`);
  info(`WebSocket: ${targetPage.webSocketDebuggerUrl}\n`);

  const ws = await connectPage(targetPage.webSocketDebuggerUrl);
  await cdpSend(ws, 'Runtime.enable');

  try {
    // Run tests
    await testStealth(ws);
    await testVideoSpeed(ws);
    await testSectionDetection(ws);
    await testMinimizeSimulation(ws);
    await testSpeedDisplaySync(ws);
    await testProgressReporting(ws);
    await testCourseScraping(ws);
    await testContentScriptComm(ws);
  } catch (e) {
    console.error('\n❌ Test error:', e.message);
  }

  // Summary
  console.log('\n====================================');
  console.log('📊 TEST SUMMARY');
  console.log('====================================');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  Total: ${results.length}`);
  if (failed > 0) {
    console.log('\n  Failed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`    ❌ ${r.name}: ${r.detail}`);
    });
  }

  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
